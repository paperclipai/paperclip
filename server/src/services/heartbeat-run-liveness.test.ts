import { describe, expect, it, vi } from "vitest";
import { evaluateRunProcessLiveness } from "./heartbeat-run-liveness.js";

const BOUND_EPOCH_MS = 1_700_000_000_000;
const BOUND_EXE = process.platform === "win32" ? "C:\\rt\\node.exe" : "/rt/node";

function deps(overrides: {
  alive?: boolean;
  observed?: { startedAtEpochMs: number; executablePath: string };
  throws?: boolean;
}) {
  return {
    isProcessAlive: () => overrides.alive ?? true,
    readObservedProcessIdentity: vi.fn(async () => {
      if (overrides.throws) throw new Error("could not read process identity");
      return (
        overrides.observed ?? { startedAtEpochMs: BOUND_EPOCH_MS, executablePath: BOUND_EXE }
      );
    }),
  };
}

const boundRun = {
  processPid: 4242,
  processStartedAtEpochMs: BOUND_EPOCH_MS,
  processExecutablePath: BOUND_EXE,
};

describe("evaluateRunProcessLiveness", () => {
  it("treats an absent PID as provably dead and unkillable", async () => {
    const result = await evaluateRunProcessLiveness(
      { ...boundRun, processPid: null },
      deps({}),
    );
    expect(result).toMatchObject({ alive: false, safeToTerminatePid: false, provablyDead: true, reason: "pid_absent" });
  });

  it("treats a dead PID as provably dead and unkillable", async () => {
    const result = await evaluateRunProcessLiveness(boundRun, deps({ alive: false }));
    expect(result).toMatchObject({ alive: false, safeToTerminatePid: false, provablyDead: true, reason: "pid_dead" });
  });

  it("confirms a live PID whose OS creation identity matches the bound identity", async () => {
    const d = deps({});
    const result = await evaluateRunProcessLiveness(boundRun, d);
    expect(result).toMatchObject({ alive: true, safeToTerminatePid: true, provablyDead: false, reason: "identity_match" });
    expect(d.readObservedProcessIdentity).toHaveBeenCalledWith(4242);
  });

  it("declares a recycled PID (creation-time mismatch) provably dead and never killable", async () => {
    const result = await evaluateRunProcessLiveness(
      boundRun,
      deps({ observed: { startedAtEpochMs: BOUND_EPOCH_MS + 999, executablePath: BOUND_EXE } }),
    );
    expect(result).toMatchObject({ alive: false, safeToTerminatePid: false, provablyDead: true, reason: "identity_mismatch" });
  });

  it("declares a recycled PID (executable mismatch) provably dead and never killable", async () => {
    const otherExe = process.platform === "win32" ? "C:\\rt\\python.exe" : "/rt/python";
    const result = await evaluateRunProcessLiveness(
      boundRun,
      deps({ observed: { startedAtEpochMs: BOUND_EPOCH_MS, executablePath: otherExe } }),
    );
    expect(result.reason).toBe("identity_mismatch");
    expect(result.alive).toBe(false);
    expect(result.safeToTerminatePid).toBe(false);
  });

  it("matches executable path case-insensitively on win32", async () => {
    if (process.platform !== "win32") return;
    const result = await evaluateRunProcessLiveness(
      boundRun,
      deps({ observed: { startedAtEpochMs: BOUND_EPOCH_MS, executablePath: "C:\\RT\\NODE.EXE" } }),
    );
    expect(result.reason).toBe("identity_match");
  });

  it("preserves PID-only liveness for legacy rows with no bound identity", async () => {
    const d = deps({});
    const result = await evaluateRunProcessLiveness(
      { processPid: 4242, processStartedAtEpochMs: null, processExecutablePath: null },
      d,
    );
    expect(result).toMatchObject({ alive: true, safeToTerminatePid: true, provablyDead: false, reason: "identity_absent_legacy" });
    // Legacy path must not attempt an OS identity read.
    expect(d.readObservedProcessIdentity).not.toHaveBeenCalled();
  });

  it("fails closed without a PID kill when the live PID's identity cannot be read", async () => {
    const result = await evaluateRunProcessLiveness(boundRun, deps({ throws: true }));
    expect(result).toMatchObject({ alive: true, safeToTerminatePid: false, provablyDead: false, reason: "identity_unreadable" });
  });

  it("ignores executable identity when none was bound but still checks creation time", async () => {
    const noExeRun = { processPid: 4242, processStartedAtEpochMs: BOUND_EPOCH_MS, processExecutablePath: null };
    const match = await evaluateRunProcessLiveness(
      noExeRun,
      deps({ observed: { startedAtEpochMs: BOUND_EPOCH_MS, executablePath: "/anything" } }),
    );
    expect(match.reason).toBe("identity_match");
    const mismatch = await evaluateRunProcessLiveness(
      noExeRun,
      deps({ observed: { startedAtEpochMs: BOUND_EPOCH_MS + 1, executablePath: "/anything" } }),
    );
    expect(mismatch.reason).toBe("identity_mismatch");
  });
});
