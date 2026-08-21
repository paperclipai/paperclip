import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectPostmasterLock,
  probeProcessLiveness,
  readPostmasterLockFile,
  removeStalePostmasterLock,
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

describe("removeStalePostmasterLock", () => {
  it("removes a lock file only once the postmaster is proven dead", () => {
    const dataDir = makeDataDir();
    writeLockFile(dataDir, { pid: 4242 });

    const result = removeStalePostmasterLock(dataDir, { probeLiveness: () => "dead" });
    expect(result.removed).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "postmaster.pid"))).toBe(false);
  });

  it("never deletes the lock file of a running postmaster", () => {
    const dataDir = makeDataDir();
    writeLockFile(dataDir, { pid: 4242 });

    const result = removeStalePostmasterLock(dataDir, { probeLiveness: () => "alive" });
    expect(result.removed).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "postmaster.pid"))).toBe(true);
  });

  it("never deletes the lock file when liveness is EPERM-unknowable", () => {
    // The exact Windows regression: a live cluster whose pid answers EPERM used
    // to be classified dead, its lock file deleted, and a second postmaster
    // started over the same data directory.
    const dataDir = makeDataDir();
    writeLockFile(dataDir, { pid: 4242 });

    const result = removeStalePostmasterLock(dataDir, {
      probeLiveness: (pid) =>
        probeProcessLiveness(pid, () => {
          throw errorWithCode("EPERM");
        }),
    });

    expect(result.removed).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "postmaster.pid"))).toBe(true);
  });

  it("never deletes the lock file when liveness cannot be determined", () => {
    const dataDir = makeDataDir();
    writeLockFile(dataDir, { pid: 4242 });

    const result = removeStalePostmasterLock(dataDir, { probeLiveness: () => "unknown" });
    expect(result.removed).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "postmaster.pid"))).toBe(true);
  });
});
