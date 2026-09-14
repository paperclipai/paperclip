import { randomUUID } from "node:crypto";
import type { Sandbox } from "@daytonaio/sdk";
import type { PluginEnvironmentRunnerRecoveryParams } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

// Provider unit tests use injected sandbox objects; the standalone SDK is not
// installed by the root workspace test command.
vi.mock("@daytonaio/sdk", () => ({ DaytonaNotFoundError: class extends Error {} }));
import { handleDaytonaRunnerRecovery, MAX_RECOVERY_STATE_BYTES } from "./runner-recovery.js";

function fixture() {
  const input: PluginEnvironmentRunnerRecoveryParams = { companyId: randomUUID(), environmentId: randomUUID(), runId: randomUUID(), providerLeaseId: randomUUID(),
    driverKey: "daytona", config: {}, workspaceRoot: "/workspace/app", sessionHash: "b".repeat(64), operation: "ingress",
    workspaceConnection: { scopeId: randomUUID(), fingerprint: "a".repeat(64) },
    owner: { version: 1, pid: 40, processGroupId: 40, uid: 1000, bootId: randomUUID(), startTicks: "100" } };
  const runnerState = { schema: "paperclip.runner.durable.state.v1", runId: input.runId, lifecycle: "ready" };
  const sandbox = { id: input.providerLeaseId, state: "started", labels: { "paperclip-company-id": input.companyId, "paperclip-environment-id": input.environmentId },
    refreshData: vi.fn(async () => {}), start: vi.fn(), stop: vi.fn(), delete: vi.fn(),
    getPreviewLink: vi.fn(async () => ({ url: "https://43127-sandbox.proxy.daytona.test", token: "private-preview-token" })),
    process: { executeCommand: vi.fn(async (_command: string, _cwd: string, env: Record<string, string>) =>
      ({ exitCode: 0, result: JSON.stringify(env.PAPERCLIP_RUNNER_RECOVERY_READ ? runnerState : { state: "running" }) })) } };
  const run = () => handleDaytonaRunnerRecovery(sandbox as unknown as Sandbox, input, () => "generation");
  return { input, sandbox, runnerState, run };
}

describe("original runner endpoint and state recovery", () => {
  it("returns the private fixed-port endpoint only after two exact process observations", async () => {
    const f = fixture(); expect(await f.run()).toEqual({ state: "ready", workspaceConnection: f.input.workspaceConnection, endpoint: {
      kind: "authenticated_websocket", websocketUrl: `wss://43127-sandbox.proxy.daytona.test/api/runner/v1/connect/${f.input.runId}`,
      secretHeaders: [{ name: "X-Daytona-Preview-Token", value: "private-preview-token" }], generation: "generation",
    } });
    expect(f.sandbox.getPreviewLink).toHaveBeenCalledWith(43127);
    expect(f.sandbox.refreshData).toHaveBeenCalledTimes(2);
    expect(f.sandbox.process.executeCommand).toHaveBeenCalledTimes(2);
    for (const mutation of [f.sandbox.start, f.sandbox.stop, f.sandbox.delete]) expect(mutation).not.toHaveBeenCalled();
  });
  it.each(["stopped", "archived", "starting", "stopping", "error"])("never wakes %s compute or opens its ingress", async state => {
    const f = fixture(); f.sandbox.state = state;
    for (const operation of ["ingress", "read_state"] as const) {
      f.input.operation = operation; expect(await f.run()).toEqual({ state: "unverified" });
    }
    expect(f.sandbox.start).not.toHaveBeenCalled(); expect(f.sandbox.getPreviewLink).not.toHaveBeenCalled(); expect(f.sandbox.process.executeCommand).not.toHaveBeenCalled();
  });
  it.each(["exited", "mismatch", "unverified"])("does not expose an ingress for %s runner evidence", async state => {
    const f = fixture(); f.sandbox.process.executeCommand.mockResolvedValue({ exitCode: 0, result: JSON.stringify({ state }) });
    expect(await f.run()).toEqual({ state: "unverified" }); expect(f.sandbox.getPreviewLink).not.toHaveBeenCalled();
  });
  it("rejects ownership lost during endpoint acquisition", async () => {
    const f = fixture(); f.sandbox.getPreviewLink.mockImplementation(async () => {
      f.sandbox.labels["paperclip-company-id"] = randomUUID(); return { url: "https://43127-sandbox.proxy.daytona.test", token: "private" };
    });
    expect(await f.run()).toEqual({ state: "unverified" });
  });
  it("reads only the derived session state, with process observations before and after", async () => {
    const f = fixture(); f.input.operation = "read_state";
    expect(await f.run()).toEqual({ state: "ready", workspaceConnection: f.input.workspaceConnection, runnerState: f.runnerState });
    const calls = f.sandbox.process.executeCommand.mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[1]![1]).toBe("/tmp");
    expect(JSON.parse(calls[1]![2].PAPERCLIP_RUNNER_RECOVERY_READ)).toEqual({ root: "/workspace/app", sessionHash: f.input.sessionHash, runId: f.input.runId });
    expect(f.sandbox.getPreviewLink).not.toHaveBeenCalled(); expect(f.sandbox.start).not.toHaveBeenCalled();
  });
  it.each(["/", "/workspace/../outside", "relative", "/workspace\0suffix"])("rejects unsafe workspace %j before provider access", async root => {
    const f = fixture(); f.input.workspaceRoot = root;
    expect(await f.run()).toEqual({ state: "unverified" }); expect(f.sandbox.refreshData).not.toHaveBeenCalled();
  });
  it.each(["wrong_run", "oversized", "invalid_json", "array", "nonzero", "process_changed"])("refuses %s state without returning its contents", async cause => {
    const f = fixture(); f.input.operation = "read_state";
    f.sandbox.process.executeCommand.mockImplementation(async (_command, _cwd, env) => {
      if (env.PAPERCLIP_RUNNER_RECOVERY_READ) return { exitCode: cause === "nonzero" ? 1 : 0,
        result: cause === "oversized" ? "x".repeat(MAX_RECOVERY_STATE_BYTES + 1) : cause === "invalid_json" ? "private output" : cause === "array" ? "[]"
          : JSON.stringify({ ...f.runnerState, ...(cause === "wrong_run" ? { runId: randomUUID() } : {}) }) };
      return { exitCode: 0, result: JSON.stringify({ state: cause === "process_changed" && f.sandbox.process.executeCommand.mock.calls.length >= 3 ? "mismatch" : "running" }) };
    });
    expect(await f.run()).toEqual({ state: "unverified" });
  });
});
