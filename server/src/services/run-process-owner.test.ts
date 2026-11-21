import { describe, expect, it } from "vitest";
import { proveRunProcessGone, type RunProcessIdentity } from "./run-process-owner.js";
import type { ProcessProbe } from "./owner-proof.js";

const oldSpace = "c".repeat(32), currentSpace = "d".repeat(32);
const kernel = (processSpace: string, kernelBootId: string) => ({ schema: "paperclip.local_kernel.v1" as const,
  machineHash: "a".repeat(32), kernelBootId, processSpace });
const old = kernel(oldSpace, "11111111-1111-4111-8111-111111111111");
const current = kernel(currentSpace, "22222222-2222-4222-8222-222222222222");
const probe: ProcessProbe = { bootId: "new-controller", host: "host", processSpace: currentSpace,
  localKernelBoot: current, pidExists: () => true, processGroupExists: () => true, readStartedAt: async () => new Date() };
const run: RunProcessIdentity = { processPid: 4242, processGroupId: 4242,
  processStartedAt: new Date("2026-01-01T00:00:00Z"), processHostHash: oldSpace,
  controllerProcess: { bootId: "old-controller", pid: 1234, hostHash: oldSpace,
    processStartedAt: "2026-01-01T00:00:00Z", localKernelBoot: old } };

describe("run child kernel evidence", () => {
  it("uses the original controller's proof for a child in that exact process space", async () => {
    expect(await proveRunProcessGone(run, "test", probe)).toEqual({ verdict: "gone", reason: "kernel_restarted" });
  });

  it.each(["remote", "e".repeat(32)])("does not lend controller proof to a child in %s space", async processHostHash => {
    expect(await proveRunProcessGone({ ...run, processHostHash }, "test", probe))
      .toEqual({ verdict: "unprovable", reason: "different_process_space" });
  });

  it("keeps a previous-release run without kernel proof unprovable across boots", async () => {
    expect(await proveRunProcessGone({ ...run, controllerProcess: { bootId: "old-controller", pid: 1234,
      hostHash: oldSpace, processStartedAt: "2026-01-01T00:00:00Z" } }, "test", probe))
      .toEqual({ verdict: "unprovable", reason: "different_process_space" });
  });

  it("rejects controller evidence bound to a different saved process space", async () => {
    expect(await proveRunProcessGone({ ...run, controllerProcess: { bootId: "old-controller", pid: 1234,
      hostHash: oldSpace, localKernelBoot: { ...old, processSpace: currentSpace } } }, "test", probe))
      .toEqual({ verdict: "unprovable", reason: "different_process_space" });
  });
});