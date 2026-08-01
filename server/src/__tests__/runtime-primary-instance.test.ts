import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimRuntimePrimaryLease,
  readRuntimePrimaryLease,
  releaseRuntimePrimaryLeaseForPid,
} from "../runtime-primary-instance.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createLeasePath() {
  const dir = mkdtempSync(path.join(tmpdir(), "paperclip-runtime-primary-lease-"));
  tempDirs.push(dir);
  return path.join(dir, "runtime-primary-instance.json");
}

describe("runtime primary lease", () => {
  it("writes and releases a claimed lease", () => {
    const leasePath = createLeasePath();

    const claimed = claimRuntimePrimaryLease({
      pid: process.pid,
      requestedPort: 3100,
      startedAt: "2026-07-29T10:24:28.000Z",
      explicitPath: leasePath,
    });

    expect(claimed.acquired).toBe(true);
    expect(readRuntimePrimaryLease(leasePath)).toEqual({
      pid: process.pid,
      requestedPort: 3100,
      startedAt: "2026-07-29T10:24:28.000Z",
      instanceId: expect.any(String),
      processStartedAt: expect.any(String),
    });
    expect(releaseRuntimePrimaryLeaseForPid(process.pid, leasePath)).toBe(true);
    expect(readRuntimePrimaryLease(leasePath)).toBeNull();
  });

  it("suppresses a new claimant while a live pid still owns the lease", () => {
    const leasePath = createLeasePath();
    writeFileSync(
      leasePath,
      `${JSON.stringify({
        pid: process.pid,
        requestedPort: 3100,
        startedAt: "2026-07-29T10:14:35.000Z",
      })}\n`,
      "utf8",
    );

    const claimed = claimRuntimePrimaryLease({
      pid: process.ppid > 1 ? process.ppid : process.pid + 1,
      requestedPort: 3100,
      startedAt: "2026-07-29T10:24:28.000Z",
      explicitPath: leasePath,
    });

    expect(claimed).toMatchObject({
      acquired: false,
      existing: {
        pid: process.pid,
        requestedPort: 3100,
        startedAt: "2026-07-29T10:14:35.000Z",
        instanceId: null,
        processStartedAt: null,
      },
    });
    expect(readRuntimePrimaryLease(leasePath)).toEqual({
      pid: process.pid,
      requestedPort: 3100,
      startedAt: "2026-07-29T10:14:35.000Z",
      instanceId: null,
      processStartedAt: null,
    });
  });

  it("reclaims a stale lease when the recorded pid is no longer alive", () => {
    const leasePath = createLeasePath();
    writeFileSync(
      leasePath,
      `${JSON.stringify({
        pid: 999999,
        requestedPort: 3100,
        startedAt: "2026-07-29T08:47:46.000Z",
      })}\n`,
      "utf8",
    );

    const claimed = claimRuntimePrimaryLease({
      pid: process.pid,
      requestedPort: 3100,
      startedAt: "2026-07-29T10:24:28.000Z",
      explicitPath: leasePath,
    });

    expect(claimed.acquired).toBe(true);
    expect(readRuntimePrimaryLease(leasePath)).toEqual({
      pid: process.pid,
      requestedPort: 3100,
      startedAt: "2026-07-29T10:24:28.000Z",
      instanceId: expect.any(String),
      processStartedAt: expect.any(String),
    });
  });

  it("does not steal a live lease owner even when the new runtime wants the same port", () => {
    const leasePath = createLeasePath();
    const livePid = process.ppid > 1 ? process.ppid : process.pid;
    writeFileSync(
      leasePath,
      `${JSON.stringify({
        pid: livePid,
        requestedPort: 3100,
        startedAt: "2026-07-29T10:14:35.000Z",
      })}\n`,
      "utf8",
    );

    const claimed = claimRuntimePrimaryLease({
      pid: process.pid,
      requestedPort: 3100,
      startedAt: "2026-07-29T10:24:28.000Z",
      explicitPath: leasePath,
    });

    expect(claimed.acquired).toBe(false);
    expect(claimed.existing).toEqual({
      pid: livePid,
      requestedPort: 3100,
      startedAt: "2026-07-29T10:14:35.000Z",
      instanceId: null,
      processStartedAt: null,
    });
    expect(readRuntimePrimaryLease(leasePath)).toEqual({
      pid: livePid,
      requestedPort: 3100,
      startedAt: "2026-07-29T10:14:35.000Z",
      instanceId: null,
      processStartedAt: null,
    });
  });

  it("reclaims a recycled pid lease when the recorded process start no longer matches", () => {
    const leasePath = createLeasePath();
    writeFileSync(
      leasePath,
      `${JSON.stringify({
        pid: process.pid,
        requestedPort: 3100,
        startedAt: "2026-07-29T08:47:46.000Z",
        instanceId: "prior-instance",
        processStartedAt: null,
      })}\n`,
      "utf8",
    );

    const claimed = claimRuntimePrimaryLease({
      pid: process.pid,
      requestedPort: 3100,
      startedAt: "2026-07-29T10:24:28.000Z",
      explicitPath: leasePath,
    });

    expect(claimed.acquired).toBe(true);
    expect(readRuntimePrimaryLease(leasePath)).toEqual({
      pid: process.pid,
      requestedPort: 3100,
      startedAt: "2026-07-29T10:24:28.000Z",
      instanceId: expect.any(String),
      processStartedAt: expect.any(String),
    });
  });
});
