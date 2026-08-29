import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decideEmbeddedPostgresStart,
  inspectPostmasterLock,
  probeProcessLiveness,
  readPostmasterLockFile,
} from "./embedded-postgres-lock.js";

const createdDirs: string[] = [];

function makeDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-pgdata-"));
  createdDirs.push(dir);
  return dir;
}

/**
 * `postmaster.pid` as PostgreSQL writes it: pid, data directory, start time,
 * port, socket dir, listen address, shared memory key.
 */
function writeLockFile(
  dataDir: string,
  options: { pid: number; recordedDataDir?: string; port?: number },
): void {
  const lines = [
    String(options.pid),
    options.recordedDataDir ?? dataDir,
    "1755600000",
    String(options.port ?? 54329),
    "",
    "127.0.0.1",
    "  4242001   1234567",
  ];
  fs.writeFileSync(path.join(dataDir, "postmaster.pid"), `${lines.join("\n")}\n`);
}

function errorWithCode(code: string): Error {
  return Object.assign(new Error(code), { code });
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("probeProcessLiveness", () => {
  it("reports a signalable process as alive", () => {
    expect(probeProcessLiveness(1234, () => {})).toBe("alive");
  });

  it("reports ESRCH as dead", () => {
    expect(
      probeProcessLiveness(1234, () => {
        throw errorWithCode("ESRCH");
      }),
    ).toBe("dead");
  });

  it("reports EPERM as alive, because the process exists but is not signalable", () => {
    // Windows `OpenProcess` returns ERROR_ACCESS_DENIED (-> EPERM) for a
    // postmaster started from an elevated or different-session run. Reading
    // that as "dead" is what deletes a live cluster's lock file.
    expect(
      probeProcessLiveness(1234, () => {
        throw errorWithCode("EPERM");
      }),
    ).toBe("alive");
  });

  it("reports an unrecognized failure as unknown rather than dead", () => {
    expect(
      probeProcessLiveness(1234, () => {
        throw errorWithCode("EINVAL");
      }),
    ).toBe("unknown");
  });

  it("treats a non-positive pid as dead", () => {
    expect(probeProcessLiveness(0, () => {})).toBe("dead");
    expect(probeProcessLiveness(Number.NaN, () => {})).toBe("dead");
  });

  it("classifies a real live process and a real exited pid", () => {
    expect(probeProcessLiveness(process.pid)).toBe("alive");
    // A pid above the platform maximum can never be allocated.
    expect(probeProcessLiveness(0x7fffffff)).toBe("dead");
  });
});

describe("readPostmasterLockFile", () => {
  it("returns null when no lock file exists", () => {
    expect(readPostmasterLockFile(makeDataDir())).toBeNull();
  });

  it("parses the pid and the port that the postmaster actually listens on", () => {
    const dataDir = makeDataDir();
    writeLockFile(dataDir, { pid: 4242, port: 54331 });

    const lock = readPostmasterLockFile(dataDir);
    expect(lock?.pid).toBe(4242);
    expect(lock?.port).toBe(54331);
    expect(lock?.dataDir).toBe(dataDir);
  });
});

describe("inspectPostmasterLock", () => {
  it("reports an absent lock file", () => {
    expect(inspectPostmasterLock(makeDataDir()).status).toBe("absent");
  });

  it("reports an unparseable lock file as indeterminate, not absent", () => {
    // A file we cannot read still means something claimed the directory, and
    // that postmaster may be on a port we would never probe. Calling it
    // "absent" sends callers down the start path and recreates the duplicate
    // postmaster failure.
    const dataDir = makeDataDir();
    fs.writeFileSync(path.resolve(dataDir, "postmaster.pid"), "not-a-pid");

    const status = inspectPostmasterLock(dataDir);
    expect(status.status).toBe("indeterminate");
    if (status.status !== "indeterminate") throw new Error("expected indeterminate");
    expect(status.lock).toBeNull();
    expect(status.reason).toContain("could not be read or parsed");
  });

  it("still reports absent when no lock file exists at all", () => {
    const dataDir = makeDataDir();
    const status = inspectPostmasterLock(dataDir, {
      readLockFile: () => null,
      lockFileExists: () => false,
    });
    expect(status.status).toBe("absent");
  });

  it("treats an unreadable lock file as occupied even when the reader returns null", () => {
    const status = inspectPostmasterLock(makeDataDir(), {
      readLockFile: () => null,
      lockFileExists: () => true,
    });
    expect(status.status).toBe("indeterminate");
  });

  it("reports a live postmaster as running, carrying its real port", () => {
    const dataDir = makeDataDir();
    writeLockFile(dataDir, { pid: 4242, port: 54331 });

    const status = inspectPostmasterLock(dataDir, { probeLiveness: () => "alive" });
    expect(status.status).toBe("running");
    if (status.status !== "running") throw new Error("expected running");
    expect(status.lock.port).toBe(54331);
  });

  it("reports a lock file from a dead postmaster as stale", () => {
    const dataDir = makeDataDir();
    writeLockFile(dataDir, { pid: 4242 });

    expect(inspectPostmasterLock(dataDir, { probeLiveness: () => "dead" }).status).toBe("stale");
  });

  it("does not call an unknown liveness stale", () => {
    const dataDir = makeDataDir();
    writeLockFile(dataDir, { pid: 4242 });

    expect(inspectPostmasterLock(dataDir, { probeLiveness: () => "unknown" }).status).toBe(
      "indeterminate",
    );
  });

  it("refuses to adjudicate a lock file that records a different data directory", () => {
    const dataDir = makeDataDir();
    writeLockFile(dataDir, { pid: 4242, recordedDataDir: path.join(os.tmpdir(), "some-other-db") });

    const status = inspectPostmasterLock(dataDir, { probeLiveness: () => "dead" });
    expect(status.status).toBe("indeterminate");
  });

  it("treats a live standalone backend (negative pid) as occupied", () => {
    const dataDir = makeDataDir();
    writeLockFile(dataDir, { pid: -4242 });

    const status = inspectPostmasterLock(dataDir, { probeLiveness: () => "alive" });
    expect(status.status).toBe("indeterminate");
  });
});

describe("decideEmbeddedPostgresStart", () => {
  const dataDir = "/var/paperclip/db";
  const configuredPort = 54329;

  it("adopts our own cluster on the configured port", () => {
    expect(
      decideEmbeddedPostgresStart({
        configuredPort,
        detectedPort: 54330,
        identity: { kind: "ours" },
        dataDir,
      }),
    ).toEqual({ action: "adopt", port: configuredPort });
  });

  it("starts on the configured port when nothing holds it", () => {
    // The probe failed because the socket was refused: nothing is listening, so
    // the directory really is free.
    expect(
      decideEmbeddedPostgresStart({
        configuredPort,
        detectedPort: configuredPort,
        identity: { kind: "unidentified" },
        dataDir,
      }),
    ).toEqual({ action: "start", port: configuredPort });
  });

  it("refuses to fall back to another port when the holder could not be identified", () => {
    // The bug this guards. A connect timeout means something accepted the socket
    // and then went quiet -- our own postmaster replaying WAL looks exactly like
    // this. The old code read the failed probe as "nothing is there", took the
    // free port detectPort offered, and started a second postmaster over the
    // same data directory, which fatals with "pre-existing shared memory block
    // is still in use". A fallback changes the port, never the directory, so an
    // unidentified holder has to be fatal rather than routed around.
    const decision = decideEmbeddedPostgresStart({
      configuredPort,
      detectedPort: 54330,
      identity: { kind: "unidentified" },
      dataDir,
    });

    expect(decision.action).toBe("refuse");
    expect(decision).toMatchObject({
      reason: expect.stringContaining("could not be identified"),
    });
    expect(decision).toMatchObject({ reason: expect.stringContaining(dataDir) });
  });

  it("still falls back when the holder is proven to be a different cluster", () => {
    // Ownership established in the other direction: somebody else's cluster has
    // the port, so our directory is unowned and moving ports starts nothing over
    // live data. This path has to keep working -- refusing here would break every
    // machine that runs an unrelated PostgreSQL on the same port.
    expect(
      decideEmbeddedPostgresStart({
        configuredPort,
        detectedPort: 54330,
        identity: { kind: "other-cluster", dataDir: "/somewhere/else" },
        dataDir,
      }),
    ).toEqual({ action: "start", port: 54330 });
  });
});
