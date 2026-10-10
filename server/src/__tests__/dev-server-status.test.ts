import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getDevServerRestartRequestFilePath,
  readDevServerRestartRequest,
  readPersistedDevServerStatus,
  removeDevServerRestartRequest,
  toDevServerHealthStatus,
  writeDevServerRestartRequest,
} from "../dev-server-status.js";

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

    expect(
      readPersistedDevServerStatus({
        PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath,
      }),
    ).toEqual({
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

    expect(
      readPersistedDevServerStatus({
        PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath,
      }),
    ).toBeNull();
  });

  it("writes restart requests next to the persisted status file", () => {
    const filePath = createTempStatusFile({
      dirty: true,
      changedPathsSample: ["server/src/app.ts"],
      pendingMigrations: [],
    });

    const env = { PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath };
    expect(
      writeDevServerRestartRequest(
        {
          requestedAt: "2026-03-20T12:05:00.000Z",
          reason: "manual_restart_now",
        },
        env,
      ),
    ).toBe(true);

    const requestPath = getDevServerRestartRequestFilePath(env);
    expect(requestPath).toBe(
      path.join(path.dirname(filePath), "dev-server-restart-request.json"),
    );
    expect(requestPath && existsSync(requestPath)).toBe(true);
    expect(JSON.parse(readFileSync(requestPath!, "utf8"))).toEqual({
      requestedAt: "2026-03-20T12:05:00.000Z",
      reason: "manual_restart_now",
    });
  });

  it("correlates restart request cleanup so stale consumers cannot remove a replacement", () => {
    const filePath = createTempStatusFile({ dirty: true });
    const env = { PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath };
    expect(
      writeDevServerRestartRequest(
        {
          requestedAt: "2026-09-04T12:00:00.000Z",
          reason: "manual_restart_now",
          requestId: "restart-new",
          mode: "hot",
          previousServerIdentity: "server-start-new",
        },
        env,
      ),
    ).toBe(true);

    removeDevServerRestartRequest({ requestId: "restart-stale" }, env);
    expect(readDevServerRestartRequest(env)).toEqual({
      requestedAt: "2026-09-04T12:00:00.000Z",
      reason: "manual_restart_now",
      requestId: "restart-new",
      mode: "hot",
      previousServerIdentity: "server-start-new",
    });

    removeDevServerRestartRequest({ requestId: "restart-new" }, env);
    expect(readDevServerRestartRequest(env)).toBeNull();
  });

  it("immediately recovers an owner-less lock from an interrupted publisher", () => {
    const filePath = createTempStatusFile({ dirty: true });
    const env = { PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath };
    const requestPath = getDevServerRestartRequestFilePath(env)!;
    const lockPath = `${requestPath}.lock`;
    mkdirSync(lockPath);

    writeDevServerRestartRequest(
      {
        requestedAt: "2026-09-04T12:00:01.000Z",
        reason: "manual_restart_now",
        requestId: "restart-after-crash",
        mode: "hot",
      },
      env,
    );

    expect(readDevServerRestartRequest(env)).toMatchObject({
      requestId: "restart-after-crash",
      requestedAt: "2026-09-04T12:00:01.000Z",
    });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("preserves the request instead of throwing when a live writer holds the lock", () => {
    const filePath = createTempStatusFile({ dirty: true });
    const env = { PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath };
    writeDevServerRestartRequest(
      {
        requestedAt: "2026-09-04T12:00:02.000Z",
        reason: "manual_restart_now",
        requestId: "restart-contended",
        mode: "hot",
      },
      env,
    );
    const requestPath = getDevServerRestartRequestFilePath(env)!;
    const lockPath = `${requestPath}.lock`;
    mkdirSync(lockPath);
    writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
      "utf8",
    );

    expect(
      removeDevServerRestartRequest({ requestId: "restart-contended" }, env),
    ).toBe(false);
    expect(readDevServerRestartRequest(env)).toMatchObject({
      requestId: "restart-contended",
    });
  });
});
