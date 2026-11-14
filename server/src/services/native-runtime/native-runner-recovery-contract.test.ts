import { describe, expect, it } from "vitest";
import { REMOTE_RUNNER_RECONNECT_GRACE_MS, localRunnerProcessReconnectGraceMs } from "./native-runner-recovery-contract.js";

describe("local runner process reconnect grace", () => {
  it("bounds a warm local runner that loses its controller", () => {
    // A warm runner outlives its turn; without a grace a controller crash leaves it ownerless.
    expect(localRunnerProcessReconnectGraceMs({ mode: "warm" })).toBe(REMOTE_RUNNER_RECONNECT_GRACE_MS);
  });

  it("leaves a per-turn local runner on its connection-lease bound", () => {
    expect(localRunnerProcessReconnectGraceMs({ mode: "per_turn" })).toBeUndefined();
  });

  it("outlasts a controller restart so a live turn can reattach", () => {
    // Local control-plane restarts take 13-20 s; long outage faults hold 3-5 minutes.
    expect(localRunnerProcessReconnectGraceMs({ mode: "warm" })!).toBeGreaterThan(5 * 60_000);
  });
});
