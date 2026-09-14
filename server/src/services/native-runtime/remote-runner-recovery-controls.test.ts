import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { EnvironmentRuntimeService } from "../environment-runtime.js";
import { createRemoteRunnerRecoveryControls } from "./remote-runner-recovery-controls.js";
import type { RemoteRunnerRecoveryProcess } from "./remote-runner-recovery.js";

function fixture(bindController = true) {
  const companyId = randomUUID(), runId = randomUUID();
  const process: RemoteRunnerRecoveryProcess = { processLocation: "remote", pid: 42, processGroupId: null, startedAt: new Date().toISOString(),
    remoteProcessIdentity: { version: 1, pid: 42, processGroupId: 42, uid: 1000, bootId: randomUUID(), startTicks: "100" },
    environmentLeaseId: randomUUID(), environmentId: randomUUID(), providerLeaseId: randomUUID(), workspaceRoot: "/workspace/app",
    configurationDigest: "b".repeat(64), workspaceConnection: { scopeId: randomUUID(), fingerprint: "a".repeat(64) } };
  const expected = structuredClone(process);
  const controlRunProcess = vi.fn<EnvironmentRuntimeService["controlRunProcess"]>(async input => ({ state: input.operation.action === "inspect" ? "running" : "signalled", process: expected }));
  const endpoint = { kind: "authenticated_websocket" as const, websocketUrl: `wss://43127-sandbox.proxy.daytona.test/api/runner/v1/connect/${runId}`,
    secretHeaders: [{ name: "X-Daytona-Preview-Token", value: "private-preview-token" }], generation: "one" };
  const runnerState = { runId, lifecycle: "ready" };
  const recoverRunner = vi.fn<EnvironmentRuntimeService["recoverRunner"]>(async input => input.operation === "ingress"
    ? { state: "ready", workspaceConnection: expected.workspaceConnection, endpoint }
    : { state: "ready", workspaceConnection: expected.workspaceConnection, runnerState });
  const executeRecoveringRunner = vi.fn<EnvironmentRuntimeService["executeRecoveringRunner"]>(async () => ({ state: "executed", workspaceConnection: expected.workspaceConnection,
    result: { exitCode: 0, timedOut: false, stdout: "checkpoint", stderr: "" } }));
  const controls = createRemoteRunnerRecoveryControls({ companyId, runId, process, runtime: { controlRunProcess, recoverRunner, executeRecoveringRunner } });
  const controller = { leaseOwner: "original-controller", controllerGeneration: 2 };
  if (bindController) controls.nativeRunnerRecovery.bindController(controller);
  return { companyId, runId, process, expected, controller, controlRunProcess, recoverRunner, executeRecoveringRunner, endpoint, runnerState, controls,
    ingress: () => controls.getRunnerIngressEndpoint({ leaseId: expected.environmentLeaseId, port: 43127, path: `/api/runner/v1/connect/${runId}` }) };
}
describe("host-bound native recovery callbacks", () => {
  it("allows only the initial liveness probe before controller binding", async () => {
    const f = fixture(false);
    expect(await f.controls.nativeRunnerRecovery.isAlive()).toBe(true);
    expect(f.controlRunProcess.mock.calls[0]![0]).not.toHaveProperty("expectedController");
    f.controlRunProcess.mockClear();
    await expect(f.controls.nativeRunnerRecovery.signal("SIGTERM")).rejects.toThrow("recovery_unverified");
    await expect(f.controls.nativeRunnerRecovery.readState()).rejects.toThrow("recovery_unverified");
    await expect(f.controls.execute({ command: "tar" })).rejects.toThrow("recovery_unverified");
    await expect(f.ingress()).rejects.toThrow("recovery_unverified");
    expect(f.controlRunProcess).not.toHaveBeenCalled(); expect(f.recoverRunner).not.toHaveBeenCalled(); expect(f.executeRecoveringRunner).not.toHaveBeenCalled();
  });
  it("pins one controller for every callback, ignoring caller mutation and refusing a different owner", async () => {
    const f = fixture(false), expectedController = { ...f.controller };
    f.controls.nativeRunnerRecovery.bindController(f.controller);
    f.controls.nativeRunnerRecovery.bindController({ ...expectedController });
    f.controller.leaseOwner = "another-controller"; f.controller.controllerGeneration++;
    expect(() => f.controls.nativeRunnerRecovery.bindController(f.controller)).toThrow("recovery_unverified");
    expect(() => f.controls.nativeRunnerRecovery.bindController({ ...expectedController, controllerGeneration: 3 })).toThrow("recovery_unverified");
    expect(() => f.controls.nativeRunnerRecovery.bindController({ ...expectedController, leaseOwner: "another" })).toThrow("recovery_unverified");
    await f.controls.nativeRunnerRecovery.isAlive(); await f.controls.nativeRunnerRecovery.signal("SIGTERM");
    await f.controls.nativeRunnerRecovery.readState(); const endpoint = await f.ingress(); await endpoint.refresh();
    await f.controls.execute({ command: "tar" });
    for (const callback of [f.controlRunProcess, f.recoverRunner, f.executeRecoveringRunner]) {
      for (const [request] of callback.mock.calls) expect(request).toMatchObject({ expectedController });
    }
  });
  it("does not reuse an outstanding unbound probe after controller binding", async () => {
    const f = fixture(false);
    let finish!: () => void;
    f.controlRunProcess.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finish = resolve; }); return { state: "running", process: f.expected };
    });
    const unbound = f.controls.nativeRunnerRecovery.isAlive();
    f.controls.nativeRunnerRecovery.bindController(f.controller);
    const bound = f.controls.nativeRunnerRecovery.isAlive();
    try {
      expect(bound).not.toBe(unbound); expect(await bound).toBe(true);
      expect(f.controlRunProcess.mock.calls[1]![0]).toMatchObject({ expectedController: f.controller });
    } finally { finish(); await unbound; }
  });
  it("executes checkpoint work through the immutable original recovery binding", async () => {
    const f = fixture(); f.process.environmentLeaseId = randomUUID();
    const execution = { command: "tar", args: ["-czf", "-", "."], cwd: "/workspace/app", timeoutMs: 120_000 };
    expect(await f.controls.execute(execution)).toMatchObject({ exitCode: 0, stdout: "checkpoint" });
    expect(f.executeRecoveringRunner).toHaveBeenCalledWith({ companyId: f.companyId, runId: f.runId, expectedProcess: f.expected, expectedController: f.controller, execution });
    expect(f.controlRunProcess).not.toHaveBeenCalled(); expect(f.recoverRunner).not.toHaveBeenCalled();
  });
  it.each(["unverified", "connection", "timeout", "no_exit"])("does not treat %s checkpoint work as a normal command result", async cause => {
    const f = fixture(); f.executeRecoveringRunner.mockResolvedValueOnce(cause === "unverified" ? { state: "unverified" } : {
      state: "executed", workspaceConnection: { ...f.expected.workspaceConnection, ...(cause === "connection" ? { fingerprint: "foreign" } : {}) },
      result: { exitCode: cause === "no_exit" ? null : 0, timedOut: cause === "timeout", stdout: "private state", stderr: "" },
    });
    await expect(f.controls.execute({ command: "tar" })).rejects.toThrow("recovery_unverified");
  });
  it.each([[undefined, 30_000], [15_000, 15_000], [300_000, 120_000]])("bounds the copy client's %s timeout to %s", async (requested, expected) => {
    const f = fixture(); await f.controls.execute({ command: "tar", timeoutMs: requested });
    expect(f.executeRecoveringRunner).toHaveBeenCalledWith(expect.objectContaining({ execution: { command: "tar", timeoutMs: expected } }));
  });
  it.each([0, -1, Infinity, NaN])("refuses invalid command timeout %s before provider access", async timeoutMs => {
    const f = fixture(); await expect(f.controls.execute({ command: "tar", timeoutMs })).rejects.toThrow("recovery_unverified");
    expect(f.executeRecoveringRunner).not.toHaveBeenCalled();
  });
  it("pins ownership, coalesces overlapping inspections and never caches completed evidence", async () => {
    const f = fixture(); const kill = vi.spyOn(process, "kill");
    try {
      f.process.remoteProcessIdentity.startTicks = "mutated"; f.process.workspaceRoot = "/changed";
      const first = f.controls.nativeRunnerRecovery.isAlive(), second = f.controls.nativeRunnerRecovery.isAlive();
      expect(first).toBe(second); expect(await first).toBe(true); expect(f.controlRunProcess).toHaveBeenCalledOnce();
      expect(await f.controls.nativeRunnerRecovery.isAlive()).toBe(true); expect(f.controlRunProcess).toHaveBeenCalledTimes(2);
      expect(f.controlRunProcess).toHaveBeenCalledWith({ companyId: f.companyId, runId: f.runId, environmentLeaseId: f.expected.environmentLeaseId,
        expectedOwner: f.expected.remoteProcessIdentity, expectedController: f.controller, operation: { action: "inspect" } });
      expect(kill).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); }
  });
  it.each(["unverified", "mismatch", "wrong_binding"])("does not turn %s into a process exit", async cause => {
    const f = fixture(); f.controlRunProcess.mockResolvedValueOnce({ state: cause === "wrong_binding" ? "running" : cause as "unverified" | "mismatch",
      process: cause === "wrong_binding" ? { ...f.expected, environmentLeaseId: randomUUID() } : f.expected });
    await expect(f.controls.nativeRunnerRecovery.isAlive()).rejects.toThrow("recovery_unverified");
    f.controlRunProcess.mockResolvedValueOnce({ state: "exited", process: f.expected }); expect(await f.controls.nativeRunnerRecovery.isAlive()).toBe(false);
  });
  it("signals only the exact captured root through the provider capability", async () => {
    const f = fixture(); await expect(f.controls.nativeRunnerRecovery.signal("SIGUSR1")).rejects.toThrow("recovery_unverified");
    expect(f.controlRunProcess).not.toHaveBeenCalled(); expect(await f.controls.nativeRunnerRecovery.signal("SIGTERM")).toBe(true);
    expect(f.controlRunProcess).toHaveBeenCalledWith({ companyId: f.companyId, runId: f.runId, environmentLeaseId: f.expected.environmentLeaseId,
      expectedOwner: f.expected.remoteProcessIdentity, expectedController: f.controller, operation: { action: "signal", signal: "SIGTERM" } });
  });
  it("keeps endpoint credentials out of JSON and revalidates the original capability on refresh", async () => {
    const f = fixture(); const endpoint = await f.ingress();
    expect(endpoint.secretHeaders[0]!.value).toBe("private-preview-token"); expect(JSON.stringify(endpoint)).not.toContain("private-preview-token");
    const refreshed = await endpoint.refresh(); expect(refreshed.websocketUrl).toBe(endpoint.websocketUrl); expect(f.recoverRunner).toHaveBeenCalledTimes(2);
    f.recoverRunner.mockResolvedValueOnce({ state: "unverified" }); await expect(endpoint.refresh()).rejects.toThrow("recovery_unverified");
  });
  it.each(["protocol", "credentials", "path", "query", "hash", "generation", "header_name", "header_value", "extra_header"])("refuses invalid endpoint %s", async cause => {
    const f = fixture();
    if (cause === "protocol") f.endpoint.websocketUrl = f.endpoint.websocketUrl.replace("wss:", "ws:");
    if (cause === "credentials") f.endpoint.websocketUrl = f.endpoint.websocketUrl.replace("wss://", "wss://private@");
    if (cause === "path") f.endpoint.websocketUrl = f.endpoint.websocketUrl.replace(f.runId, randomUUID());
    if (cause === "query") f.endpoint.websocketUrl += "?secret=private";
    if (cause === "hash") f.endpoint.websocketUrl += "#private";
    if (cause === "generation") f.endpoint.generation = "";
    if (cause === "header_name") f.endpoint.secretHeaders[0]!.name = "Authorization";
    if (cause === "header_value") f.endpoint.secretHeaders[0]!.value += "\r\nInjected: bad";
    if (cause === "extra_header") f.endpoint.secretHeaders.push({ name: "Cookie", value: "private" });
    await expect(f.ingress()).rejects.toThrow("recovery_unverified");
  });
  it("rejects different ports and run paths before asking the provider", async () => {
    const f = fixture(); await expect(f.controls.getRunnerIngressEndpoint({ leaseId: f.expected.environmentLeaseId, port: 3000, path: `/api/runner/v1/connect/${f.runId}` })).rejects.toThrow("recovery_unverified");
    await expect(f.controls.getRunnerIngressEndpoint({ leaseId: f.expected.environmentLeaseId, port: 43127, path: `/api/runner/v1/connect/${randomUUID()}` })).rejects.toThrow("recovery_unverified");
    await expect(f.controls.getRunnerIngressEndpoint({ leaseId: randomUUID(), port: 43127, path: `/api/runner/v1/connect/${f.runId}` })).rejects.toThrow("recovery_unverified");
    expect(f.recoverRunner).not.toHaveBeenCalled();
  });
  it("reads state only through the original binding and rejects foreign state", async () => {
    const f = fixture(); expect(await f.controls.nativeRunnerRecovery.readState()).toEqual(f.runnerState);
    expect(f.recoverRunner).toHaveBeenCalledWith({ companyId: f.companyId, runId: f.runId, expectedProcess: f.expected, expectedController: f.controller, operation: "read_state" });
    f.runnerState.runId = randomUUID(); await expect(f.controls.nativeRunnerRecovery.readState()).rejects.toThrow("recovery_unverified");
  });
});
