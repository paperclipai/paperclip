import { QUALIFIED_ACPX_PROFILES } from "../../packages/paperclip-runner/src/drivers/acpx/qualified-profiles.js";
import { describe, expect, it } from "vitest";
import { rollController, validControllerRollingDeploymentReceipt } from "./controller-rolling-deployment.js";
import { validControllerReplacementReceipt } from "./controller-replacement.js";
import { controllerOutageForExecution, validControllerOutageReceipt } from "./controller-outage.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { runnerProfiles, extendedHarnessProfiles, kimiRunnerProfile, runnerSuites } from "./catalog.js";

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
  it("requires both lifecycle modes for every production-qualified native sandbox profile", () => {
    const executions = ["rolling-web-deployment", "rolling-web-deployment-warm"]
      .flatMap(suite => selectRunnerExecutions(parseRunnerSelectors(["--suite", suite])));
    const native = [...runnerProfiles, ...extendedHarnessProfiles, kimiRunnerProfile]
      .filter(profile => profile.generation === "native" && profile.supportedEnvironments.includes("daytona")
        && (!profile.qualificationCandidate || QUALIFIED_ACPX_PROFILES[profile.qualificationCandidate].qualificationStatus !== "pending"));
    const kind = (profile: (typeof native)[number]) => {
      const provider = profile.expectedRuntimeMetadata.provider;
      const harness = "acpxAgent" in profile ? profile.acpxAgent
        : provider === "acpx" && profile.provider !== "acpx" ? profile.provider : "";
      return `${provider}:${harness}`;
    };
    const registeredKinds = new Set(runnerSuites.flatMap(suite => suite.profiles)
      .filter(profile => profile.generation === "native" && profile.supportedEnvironments.includes("daytona")
        && (!profile.qualificationCandidate || QUALIFIED_ACPX_PROFILES[profile.qualificationCandidate].qualificationStatus !== "pending"))
      .map(kind));
    expect(new Set(native.map(kind))).toEqual(registeredKinds);
    for (const profile of native) {
      const cells = executions.filter(execution => execution.profile.id === profile.id);
      expect(cells).toHaveLength(2);
      expect(cells.every(cell => !cell.profile.qualificationCandidate)).toBe(true);
      expect(new Set(cells.map(cell => cell.environment.configurationKey ?? "per_turn")))
        .toEqual(new Set(["per_turn", "warm-controller-outage-v1"]));
    }
    expect(executions.every(execution => execution.suite.definitionMetadata?.retainedControllerContinuation === true)).toBe(true);
  });
});
