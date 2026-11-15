import { describe, expect, it } from "vitest";
import type { NativeRestartRecoveryClaim } from "../native-runtime/native-restart-recovery.js";
import { adoptsLiveRemoteRunner } from "./live-runner-adoption.js";

const run = { id: "run-1", runtimeMode: "native" as const };
const base = { runId: "run-1", leaseOwner: "owner-1", controllerGeneration: 2, providerAttempt: 1,
  restartKind: "hard" as const, recoveryRequestId: null };
const reattach = { ...base, kind: "reattach_remote_runner", remote: { providerLeaseId: "lease-1", remoteCwd: "/w" } } as NativeRestartRecoveryClaim;

describe("adoptsLiveRemoteRunner", () => {
  it("adopts only this run's retained remote Runner under the claim's own owner", () => {
    expect(adoptsLiveRemoteRunner({ run, restartRecovery: reattach, leaseOwner: "owner-1" })).toBe(true);
  });

  it.each([
    ["a normal turn start", { run, restartRecovery: undefined, leaseOwner: undefined }],
    ["a scheduled resume without a restart claim", { run, restartRecovery: undefined, leaseOwner: "owner-1" }],
    ["a dead Runner resume", { run, restartRecovery: { ...base, kind: "resume_dead_runner" } as NativeRestartRecoveryClaim, leaseOwner: "owner-1" }],
    ["an incomplete bootstrap", { run, restartRecovery: { ...base, kind: "bootstrap_incomplete" } as NativeRestartRecoveryClaim, leaseOwner: "owner-1" }],
    ["another run's claim", { run: { ...run, id: "run-2" }, restartRecovery: reattach, leaseOwner: "owner-1" }],
    ["a different lease owner", { run, restartRecovery: reattach, leaseOwner: "owner-2" }],
    ["a legacy run", { run: { ...run, runtimeMode: "legacy" as const }, restartRecovery: reattach, leaseOwner: "owner-1" }],
  ])("takes the full preparation for %s", (_name, input) => {
    expect(adoptsLiveRemoteRunner(input as Parameters<typeof adoptsLiveRemoteRunner>[0])).toBe(false);
  });
});
