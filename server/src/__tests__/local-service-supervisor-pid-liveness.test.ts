import { describe, expect, it } from "vitest";

import { isPidAlive, isProcessGroupAlive } from "../services/local-service-supervisor.ts";

// `process.kill(pid, 0)` sends no signal, it asks whether the caller *could*
// signal that process. It therefore has two distinct failure modes, and only
// one of them means the process is gone:
//
//   ESRCH — no such process. Dead.
//   EPERM — the process exists, the caller may not signal it. Alive.
//
// The recovery backstop reads these helpers as run liveness, so folding EPERM
// into "dead" makes it terminalize runs it merely cannot reach. hot-restart.ts
// has always had this right; these helpers had not.
describe("isPidAlive", () => {
  it("reports a live process as alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("reports a pid that cannot exist as dead", () => {
    expect(isPidAlive(2_000_000_000)).toBe(false);
  });

  it("rejects pids that are not usable process ids", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });

  it("reports a process owned by another user as alive, not dead", () => {
    // pid 1 (init/launchd) is root-owned, so an unprivileged process gets EPERM
    // rather than ESRCH. Running as root gets no error at all, which the same
    // assertion still covers; on Windows the semantics do not apply.
    if (process.platform === "win32") return;
    let signalError: NodeJS.ErrnoException | null = null;
    try {
      process.kill(1, 0);
    } catch (error) {
      signalError = error as NodeJS.ErrnoException;
    }
    if (signalError && signalError.code !== "EPERM") return; // not the case under test
    expect(isPidAlive(1)).toBe(true);
  });
});

describe("isProcessGroupAlive", () => {
  it("reports a group id that cannot exist as dead", () => {
    if (process.platform === "win32") return;
    expect(isProcessGroupAlive(2_000_000_000)).toBe(false);
  });

  it("rejects group ids that are not usable", () => {
    expect(isProcessGroupAlive(null)).toBe(false);
    expect(isProcessGroupAlive(undefined)).toBe(false);
    expect(isProcessGroupAlive(0)).toBe(false);
  });
});
