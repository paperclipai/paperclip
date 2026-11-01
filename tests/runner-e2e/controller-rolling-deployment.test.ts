import { describe, expect, it } from "vitest";
import { rollController, validControllerRollingDeploymentReceipt } from "./controller-rolling-deployment.js";
import { validControllerReplacementReceipt } from "./controller-replacement.js";
import { controllerOutageForExecution, validControllerOutageReceipt } from "./controller-outage.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";

function fixture() {
  const order: string[] = [];
  return { order, input: { requestId: "rolling-1", previousPid: 100,
    start: async () => { order.push("start-B"); return { pid: 200 }; },
    waitForReady: async () => { order.push("B-ready"); },
    beforeHandoff: async () => { order.push("observe-A"); },
    switchTraffic: () => { order.push("route-B"); },
    stopPrevious: async () => { order.push("stop-A"); },
    afterPreviousStopped: async () => { order.push("observe-A-stopped"); },
    deletePreviousHome: async () => { order.push("delete-home-A"); },
    afterHandoff: async () => { order.push("observe-recovery"); },
    cancelled: () => false, record: async () => {},
  } };
}

describe("rolling controller qualification", () => {
  it("moves traffic only after readiness, then removes all predecessor state", async () => {
    const f = fixture();
    const receipt = await rollController(f.input);
    expect(f.order).toEqual(["start-B", "B-ready", "observe-A", "route-B", "stop-A", "observe-A-stopped", "delete-home-A", "observe-recovery"]);
    expect(validControllerRollingDeploymentReceipt(receipt)).toBe(false); // A process receipt alone is not availability proof.
    receipt.probes = { reads: 10, writes: 3, verifiedWrites: 3, failures: [] };
    expect(validControllerReplacementReceipt(receipt)).toBe(true);
    expect(validControllerOutageReceipt(receipt)).toBe(false);
    for (const changed of [
      { previousHomeRemoved: false }, { cacheDiscarded: false }, { replacementPid: 100 }, { gracefulShutdown: false },
      { trafficSwitchedAfterMs: -1 }, { readyAfterMs: receipt.stoppedAfterMs! + 1 },
      { probes: { reads: 10, writes: 3, verifiedWrites: 2, failures: [] } },
      { probes: { reads: 10, writes: 3, verifiedWrites: 3, failures: ["502"] } },
    ]) expect(validControllerReplacementReceipt({ ...receipt, ...changed })).toBe(false);
    expect(validControllerRollingDeploymentReceipt(receipt, "other-request")).toBe(false);
  });
  it("keeps A serving when B never becomes ready", async () => {
    const f = fixture(); f.input.waitForReady = async () => { throw new Error("B unready"); };
    await expect(rollController(f.input)).rejects.toThrow("B unready");
    expect(f.order).toEqual(["start-B"]);
  });
  it("rejects forced predecessor cleanup before deleting its home or observing recovery", async () => {
    const f = fixture(); f.input.stopPrevious = async () => { throw new Error("forced shutdown"); };
    await expect(rollController(f.input)).rejects.toThrow("forced shutdown");
    expect(f.order).toEqual(["start-B", "B-ready", "observe-A", "route-B"]);
  });
  it("keeps the original outage contract separate from the explicit rolling cell", () => {
    const [rolling] = selectRunnerExecutions(parseRunnerSelectors(["--suite", "rolling-web-deployment"]));
    expect(rolling).toBeDefined();
    expect(rolling!.suite.manualOnly).toBe(true);
    expect(rolling!.suite.definitionMetadata?.retainedControllerContinuation).toBe(true);
    expect(controllerOutageForExecution(rolling!, {})).toBeUndefined();
    const [outage] = selectRunnerExecutions(parseRunnerSelectors(["--suite", "remote-workspace-storage"]));
    expect(controllerOutageForExecution(outage!, {})).toEqual({ signal: "SIGKILL", holdMs: 300_000 });
  });
});
