import { describe, expect, it, vi } from "vitest";
import { createWakeRecoveryAdmission } from "./recovery-admission.js";

const blocker = {
  cause: "legacy_execution_requires_reconciliation" as const,
  recoveryActionId: "recovery",
  runId: "stopped",
  nextAction: "Inspect the stopped run.",
};
const wake = { commentId: "message" };

describe("wake recovery admission", () => {
  it("withholds both ordinary admission capabilities when recovery is required", async () => {
    const admitExplicit = vi.fn().mockResolvedValue(null);
    const prepare = createWakeRecoveryAdmission({
      readBlocker: async () => ({ blocker, verifiedReset: false }),
      admitExplicit,
    }, vi.fn(), vi.fn(), vi.fn());

    const recovery = await prepare(wake);
    expect(recovery).not.toHaveProperty("admitBusy");
    expect(recovery).not.toHaveProperty("admitFresh");
    const result = await recovery.checkBusyAdmission();
    expect(result.kind).toBe("blocked");
    expect(result).not.toHaveProperty("admitBusy");
    expect(result).not.toHaveProperty("checkFreshAdmission");
    expect(admitExplicit).toHaveBeenCalledExactlyOnceWith(wake, true, expect.any(Function));
  });

  it("requires actual fresh continuation after the successful busy dry run", async () => {
    const admitExplicit = vi.fn().mockResolvedValueOnce({ previousRunId: "stopped" }).mockResolvedValueOnce(null);
    const admitBusy = vi.fn(), admitFresh = vi.fn();
    const prepare = createWakeRecoveryAdmission({
      readBlocker: async () => ({ blocker, verifiedReset: false }),
      admitExplicit,
    }, admitBusy, admitFresh, vi.fn());

    const busy = await (await prepare(wake)).checkBusyAdmission();
    expect(busy.kind).toBe("allowed");
    if (busy.kind !== "allowed") throw new Error("Expected busy admission");
    expect(busy.admitBusy).toBe(admitBusy);
    expect(admitExplicit).toHaveBeenCalledExactlyOnceWith(wake, true, expect.any(Function));
    expect(busy).not.toHaveProperty("admitFresh");
    const fresh = await busy.checkFreshAdmission();
    expect(fresh.kind).toBe("blocked");
    expect(fresh).not.toHaveProperty("admitFresh");
    expect(admitExplicit).toHaveBeenLastCalledWith(wake, false, expect.any(Function));
  });

  it("exposes normal fresh admission after the final continuation check", async () => {
    const admitExplicit = vi.fn().mockResolvedValue(null);
    const admitFresh = vi.fn();
    const prepare = createWakeRecoveryAdmission({
      readBlocker: async () => ({ blocker: null, verifiedReset: false }),
      admitExplicit,
    }, vi.fn(), admitFresh, vi.fn());
    const busy = await (await prepare(wake)).checkBusyAdmission();
    expect(admitExplicit).not.toHaveBeenCalled();
    if (busy.kind !== "allowed") throw new Error("Expected busy admission");
    const fresh = await busy.checkFreshAdmission();
    expect(fresh).toMatchObject({ kind: "allowed", admitFresh, explicitContinuation: null });
    expect(admitExplicit).toHaveBeenCalledExactlyOnceWith(wake, false, expect.any(Function));
  });
});
