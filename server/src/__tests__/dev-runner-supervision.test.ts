import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findConflictingDevSupervisor,
  formatConflictingDevSupervisorMessage,
  shouldReportHealthProbeFailure,
  type DevSupervisorRecordSummary,
} from "../../../scripts/dev-runner-supervision.ts";

const repoRoot = path.resolve("/tmp/paperclip-checkout");

function record(overrides: Partial<DevSupervisorRecordSummary> = {}): DevSupervisorRecordSummary {
  return {
    serviceKey: "paperclip-dev-paperclip-dev-once-abc",
    serviceName: "paperclip-dev-once",
    pid: 4242,
    repoRoot,
    port: 3101,
    startedAt: "2026-09-21T03:17:19.809Z",
    ...overrides,
  };
}

const alive = () => true;
const dead = () => false;

describe("findConflictingDevSupervisor", () => {
  it("reports a live supervisor that already owns the checkout", () => {
    const conflict = findConflictingDevSupervisor({
      records: [record()],
      repoRoot,
      currentPid: 9999,
      isPidAlive: alive,
    });

    expect(conflict?.pid).toBe(4242);
  });

  it("catches a rival that disagrees about the port", () => {
    // The registry's own adoption check keys on the port, so a supervisor that
    // resolved a different port slipped past it and ended up sharing one
    // status file with the incumbent (TES-2189).
    const conflict = findConflictingDevSupervisor({
      records: [record({ port: 3100, serviceKey: "paperclip-dev-paperclip-dev-once-xyz" })],
      repoRoot,
      currentPid: 9999,
      isPidAlive: alive,
    });

    expect(conflict?.pid).toBe(4242);
  });

  it("ignores a record whose process is gone", () => {
    expect(
      findConflictingDevSupervisor({
        records: [record()],
        repoRoot,
        currentPid: 9999,
        isPidAlive: dead,
      }),
    ).toBeNull();
  });

  it("ignores this process's own record", () => {
    expect(
      findConflictingDevSupervisor({
        records: [record({ pid: 9999 })],
        repoRoot,
        currentPid: 9999,
        isPidAlive: alive,
      }),
    ).toBeNull();
  });

  it("ignores a supervisor for a different checkout, so worktrees still run", () => {
    expect(
      findConflictingDevSupervisor({
        records: [record({ repoRoot: path.resolve("/tmp/other-worktree") })],
        repoRoot,
        currentPid: 9999,
        isPidAlive: alive,
      }),
    ).toBeNull();
  });

  it("matches an unnormalised repo root", () => {
    const conflict = findConflictingDevSupervisor({
      records: [record({ repoRoot: `${repoRoot}/server/..` })],
      repoRoot,
      currentPid: 9999,
      isPidAlive: alive,
    });

    expect(conflict?.pid).toBe(4242);
  });

  it("skips records with no repo root rather than guessing", () => {
    expect(
      findConflictingDevSupervisor({
        records: [record({ repoRoot: null })],
        repoRoot,
        currentPid: 9999,
        isPidAlive: alive,
      }),
    ).toBeNull();
  });
});

describe("formatConflictingDevSupervisorMessage", () => {
  it("names the pid to stop and the checkout in conflict", () => {
    const message = formatConflictingDevSupervisorMessage({
      conflict: record(),
      repoRoot,
    });

    expect(message).toContain("pid 4242");
    expect(message).toContain("port 3101");
    expect(message).toContain(repoRoot);
    expect(message).toContain("kill 4242");
  });
});

describe("shouldReportHealthProbeFailure", () => {
  it("stays quiet through a restart-sized blip", () => {
    expect(shouldReportHealthProbeFailure(1)).toBe(false);
    expect(shouldReportHealthProbeFailure(3)).toBe(false);
  });

  it("reports once the failures look permanent", () => {
    expect(shouldReportHealthProbeFailure(4)).toBe(true);
  });

  it("repeats periodically instead of on every poll", () => {
    expect(shouldReportHealthProbeFailure(5)).toBe(false);
    expect(shouldReportHealthProbeFailure(123)).toBe(false);
    expect(shouldReportHealthProbeFailure(124)).toBe(true);
    expect(shouldReportHealthProbeFailure(244)).toBe(true);
  });
});
