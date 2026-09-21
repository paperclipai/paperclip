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
  getDevServerListenerFilePath,
  getDevServerRestartRequestFilePath,
  readDevServerListenerRecord,
  readDevServerRestartRequest,
  readPersistedDevServerStatus,
  removeDevServerListenerRecord,
  removeDevServerRestartRequest,
  toDevServerHealthStatus,
  writeDevServerListenerRecord,
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

describe("dev server listener record", () => {
  function createEnv() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-dev-listener-"));
    tempDirs.push(dir);
    return {
      PAPERCLIP_DEV_SERVER_STATUS_FILE: path.join(dir, "dev-server-status.json"),
    } satisfies NodeJS.ProcessEnv;
  }

  it("round-trips the port the server actually bound", () => {
    // Without this the supervisor keeps probing the port it *requested*, and a
    // server pushed to the next free port becomes unreachable to it (TES-2189).
    const env = createEnv();
    const record = { port: 3102, pid: 27332, boundAt: "2026-09-21T15:07:14.411Z" };

    expect(writeDevServerListenerRecord(record, env)).toBe(true);
    expect(readDevServerListenerRecord(env)).toEqual(record);
  });

  it("sits beside the status file so it follows the same scoping", () => {
    const env = createEnv();

    expect(getDevServerListenerFilePath(env)).toBe(
      path.join(
        path.dirname(env.PAPERCLIP_DEV_SERVER_STATUS_FILE),
        "dev-server-listener.json",
      ),
    );
  });

  it("is inert outside a supervised dev run", () => {
    expect(getDevServerListenerFilePath({})).toBeNull();
    expect(writeDevServerListenerRecord({ port: 3101, pid: 1, boundAt: "x" }, {})).toBe(false);
    expect(readDevServerListenerRecord({})).toBeNull();
  });

  it("returns null when no record has been published", () => {
    expect(readDevServerListenerRecord(createEnv())).toBeNull();
  });

  it.each([
    [{ port: 0, pid: 27332 }, "a zero port"],
    [{ port: 70000, pid: 27332 }, "an out-of-range port"],
    [{ port: "3102", pid: 27332 }, "a string port"],
    [{ port: 3102 }, "a missing pid"],
    [{ port: 3102, pid: 0 }, "a zero pid"],
  ])("rejects %j (%s)", (payload) => {
    const env = createEnv();
    mkdirSync(path.dirname(env.PAPERCLIP_DEV_SERVER_STATUS_FILE), { recursive: true });
    writeFileSync(
      getDevServerListenerFilePath(env)!,
      `${JSON.stringify(payload)}\n`,
      "utf8",
    );

    expect(readDevServerListenerRecord(env)).toBeNull();
  });

  it("treats a malformed record as absent rather than throwing", () => {
    const env = createEnv();
    mkdirSync(path.dirname(env.PAPERCLIP_DEV_SERVER_STATUS_FILE), { recursive: true });
    writeFileSync(getDevServerListenerFilePath(env)!, "{ not json", "utf8");

    expect(readDevServerListenerRecord(env)).toBeNull();
  });

  it("removes the record without complaining when there is none", () => {
    const env = createEnv();
    writeDevServerListenerRecord({ port: 3101, pid: 64174, boundAt: "now" }, env);

    removeDevServerListenerRecord(env);
    expect(existsSync(getDevServerListenerFilePath(env)!)).toBe(false);

    expect(() => removeDevServerListenerRecord(env)).not.toThrow();
    expect(() => removeDevServerListenerRecord({})).not.toThrow();
  });
});
