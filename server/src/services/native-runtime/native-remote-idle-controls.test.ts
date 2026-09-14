import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { EnvironmentRuntimeService } from "../environment-runtime.js";
import { createNativeRemoteIdleControls, createNativeRemoteIdleProcessControls } from "./native-remote-idle-controls.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import type { RemoteRunnerRecoveryProcess } from "./remote-runner-recovery.js";

function fixture() {
  const companyId = randomUUID(), runId = randomUUID(), retentionNonce = randomUUID();
  const expected: RemoteRunnerRecoveryProcess = { processLocation: "remote", pid: 42, processGroupId: null, startedAt: new Date(0).toISOString(),
    remoteProcessIdentity: { version: 1, pid: 42, processGroupId: 42, uid: 1000, bootId: randomUUID(), startTicks: "100" },
    environmentLeaseId: randomUUID(), environmentId: randomUUID(), providerLeaseId: randomUUID(), workspaceRoot: "/workspace/app",
    configurationDigest: "b".repeat(64), workspaceConnection: { scopeId: randomUUID(), fingerprint: "a".repeat(64) } };
  const controlRunProcess = vi.fn<EnvironmentRuntimeService["controlRunProcess"]>(async request => ({
    state: request.operation.action === "inspect" ? "running" : "signalled", process: structuredClone(expected) }));
  const recoverRunner = vi.fn<EnvironmentRuntimeService["recoverRunner"]>(async () => ({ state: "ready", workspaceConnection: expected.workspaceConnection,
    runnerState: { runId, lifecycle: "ready" } }));
  const input: Parameters<typeof createNativeRemoteIdleControls>[0] = { companyId, runId, retentionNonce,
    process: structuredClone(expected), runtime: { controlRunProcess, recoverRunner } };
  return { input, expected, controlRunProcess, recoverRunner };
}

describe("native idle callbacks bound to the actual controller", () => {
  it("adapts idle authority to launch-receipt-bound controls without adding command access", async () => {
    const f = fixture(), owner = structuredClone(f.expected.remoteProcessIdentity);
    const pending = createNativeRemoteIdleProcessControls(f.input);
    f.input.process.remoteProcessIdentity.pid++;
    const controls = await pending;
    expect(Object.keys(controls).sort()).toEqual(["inspect", "readState", "signal"]);
    expect(await controls.inspect(owner)).toBe("running");
    expect(await controls.signal(owner, "SIGTERM")).toBe("signalled");
    expect(await controls.readState(owner)).toMatchObject({ runId: f.input.runId });
    f.controlRunProcess.mockClear(); f.recoverRunner.mockClear();
    const foreign = { ...owner, startTicks: "999" };
    await expect(controls.inspect(foreign)).rejects.toThrow("idle_authority_unverified");
    await expect(controls.signal(foreign, "SIGKILL")).rejects.toThrow("idle_authority_unverified");
    await expect(controls.readState(foreign)).rejects.toThrow("idle_authority_unverified");
    expect(f.controlRunProcess).not.toHaveBeenCalled(); expect(f.recoverRunner).not.toHaveBeenCalled();
  });
  it("pins the process before asynchronous construction and uses this controller for every operation", async () => {
    const f = fixture(), original = structuredClone({ companyId: f.input.companyId, runId: f.input.runId, retentionNonce: f.input.retentionNonce });
    const pending = createNativeRemoteIdleControls(f.input);
    f.input.process.remoteProcessIdentity.pid++;
    f.input.process.workspaceConnection.scopeId = "changed";
    f.input.retentionNonce = randomUUID();
    const controls = await pending;
    expect(Object.keys(controls).sort()).toEqual(["isAlive", "readState", "signal"]);
    expect(await controls.isAlive()).toBe(true);
    expect(await controls.signal("SIGTERM")).toBe(true);
    expect(await controls.readState()).toEqual({ runId: original.runId, lifecycle: "ready" });
    const controller = await currentNativeControllerIdentity();
    for (const [request] of [...f.controlRunProcess.mock.calls, ...f.recoverRunner.mock.calls]) {
      expect(request).toMatchObject({ companyId: original.companyId, runId: original.runId,
        expectedRetention: { nonce: original.retentionNonce, bootId: controller.bootId, pid: process.pid, processStartedAt: controller.processStartedAt.toISOString() } });
      expect(request).not.toHaveProperty("expectedController");
    }
    expect(f.controlRunProcess.mock.calls[0]![0]).toMatchObject({ environmentLeaseId: f.expected.environmentLeaseId, expectedOwner: f.expected.remoteProcessIdentity });
    expect(f.recoverRunner.mock.calls[0]![0]).toMatchObject({ expectedProcess: f.expected, operation: "read_state" });
  });
  it("rejects malformed retention authority before invoking a provider", async () => {
    const f = fixture(); f.input.retentionNonce = "";
    await expect(createNativeRemoteIdleControls(f.input)).rejects.toThrow("idle_authority_unverified");
    expect(f.controlRunProcess).not.toHaveBeenCalled(); expect(f.recoverRunner).not.toHaveBeenCalled();
  });
  it.each(["unverified", "mismatch", "foreign_process"])("does not treat %s observation as process exit", async cause => {
    const f = fixture(), controls = await createNativeRemoteIdleControls(f.input);
    f.controlRunProcess.mockResolvedValueOnce({ state: cause === "foreign_process" ? "running" : cause as "unverified" | "mismatch",
      process: cause === "foreign_process" ? { ...f.expected, providerLeaseId: randomUUID() } : f.expected });
    await expect(controls.isAlive()).rejects.toThrow("idle_authority_unverified");
    f.controlRunProcess.mockResolvedValueOnce({ state: "exited", process: f.expected });
    expect(await controls.isAlive()).toBe(false);
  });
  it("allows only supported signals and requires a verified response", async () => {
    const f = fixture(), controls = await createNativeRemoteIdleControls(f.input);
    await expect(controls.signal("SIGUSR1")).rejects.toThrow("idle_authority_unverified");
    expect(f.controlRunProcess).not.toHaveBeenCalled();
    f.controlRunProcess.mockResolvedValueOnce({ state: "mismatch", process: f.expected });
    await expect(controls.signal("SIGKILL")).rejects.toThrow("idle_authority_unverified");
  });
  it.each(["unverified", "connection", "run"])("refuses %s state instead of granting continuity", async cause => {
    const f = fixture(), controls = await createNativeRemoteIdleControls(f.input);
    f.recoverRunner.mockResolvedValueOnce(cause === "unverified" ? { state: "unverified" } : { state: "ready",
      workspaceConnection: { ...f.expected.workspaceConnection, ...(cause === "connection" ? { fingerprint: "c".repeat(64) } : {}) },
      runnerState: { runId: cause === "run" ? randomUUID() : f.input.runId, lifecycle: "ready" } });
    await expect(controls.readState()).rejects.toThrow("idle_authority_unverified");
  });
});
