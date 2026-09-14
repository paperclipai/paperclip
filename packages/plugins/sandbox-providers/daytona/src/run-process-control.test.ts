import { randomUUID } from "node:crypto";
import type { Sandbox } from "@daytonaio/sdk";
import { describe, expect, it, vi } from "vitest";

// Provider unit tests use injected sandbox objects; the standalone SDK is not
// installed by the root workspace test command.
vi.mock("@daytonaio/sdk", () => ({ DaytonaNotFoundError: class extends Error {} }));
import type { PluginEnvironmentRunProcessControlParams } from "@paperclipai/plugin-sdk";
import { handleDaytonaRunProcessControl } from "./run-process-control.js";
import { SERVICE_DATA_DELETION_LABEL } from "./service-data-deletion.js";

function fixture() {
  const input: PluginEnvironmentRunProcessControlParams = { driverKey: "daytona", companyId: randomUUID(), environmentId: randomUUID(), providerLeaseId: randomUUID(),
    config: { apiKey: "fixture-provider-secret" }, workspaceConnection: { scopeId: randomUUID(), fingerprint: "a".repeat(64) },
    owner: { version: 1, pid: 40, processGroupId: 40, uid: 1000, bootId: randomUUID(), startTicks: "100" }, operation: { action: "inspect" } };
  const sandbox = { id: input.providerLeaseId, state: "started", labels: { "paperclip-company-id": input.companyId, "paperclip-environment-id": input.environmentId } as Record<string, string>,
    refreshData: vi.fn(async () => {}), start: vi.fn(), stop: vi.fn(), delete: vi.fn(), setLabels: vi.fn(), setTtl: vi.fn(),
    process: { executeCommand: vi.fn(async () => ({ exitCode: 0, result: '{"state":"running"}' })) } };
  return { input, sandbox, run: () => handleDaytonaRunProcessControl(sandbox as unknown as Sandbox, input) };
}

describe("Daytona original-allocation runner control", () => {
  it("executes only the fixed kernel program and preserves compute lifecycle", async () => {
    const f = fixture(); expect(await f.run()).toEqual({ state: "running" });
    const args = f.sandbox.process.executeCommand.mock.calls[0] as unknown as [string, string, Record<string, string>, number];
    expect(args[0]).toMatch(/^node -e /); expect(args[1]).toBe("/tmp"); expect(args[3]).toBe(12);
    expect(JSON.parse(args[2].PAPERCLIP_REMOTE_PROCESS_CONTROL)).toEqual({ owner: f.input.owner, operation: f.input.operation });
    expect(args[2]).toMatchObject({ NODE_OPTIONS: "", NODE_PATH: "" });
    expect(JSON.stringify(args)).not.toContain("fixture-provider-secret");
    for (const mutation of [f.sandbox.start, f.sandbox.stop, f.sandbox.delete, f.sandbox.setLabels, f.sandbox.setTtl]) expect(mutation).not.toHaveBeenCalled();
  });
  it.each(["company", "environment", "sandbox"])("rejects changed %s ownership before any kernel command", async kind => {
    const f = fixture(); f.sandbox.refreshData.mockImplementation(async () => {
      if (kind === "sandbox") f.sandbox.id = randomUUID(); else f.sandbox.labels[`paperclip-${kind}-id`] = randomUUID();
    });
    expect(await f.run()).toEqual({ state: "unverified" }); expect(f.sandbox.process.executeCommand).not.toHaveBeenCalled();
  });
  it.each(["stopped", "archived"])("never wakes %s compute to inspect or signal an old runner", async state => {
    const f = fixture(); f.sandbox.state = state;
    expect(await f.run()).toEqual({ state: "exited" });
    f.input.operation = { action: "signal", signal: "SIGKILL" }; expect(await f.run()).toEqual({ state: "exited" });
    f.input.operation = { action: "stop_group" }; expect(await f.run()).toEqual({ state: "stopped" });
    expect(f.sandbox.process.executeCommand).not.toHaveBeenCalled(); expect(f.sandbox.start).not.toHaveBeenCalled();
  });
  it.each(["starting", "stopping", "error", "destroyed"])("does not interpret %s as verified process exit", async state => {
    const f = fixture(); f.sandbox.state = state;
    expect(await f.run()).toEqual({ state: "unverified" }); expect(f.sandbox.process.executeCommand).not.toHaveBeenCalled();
  });
  it("does not cross a data-deletion fence", async () => {
    const f = fixture(); f.sandbox.labels[SERVICE_DATA_DELETION_LABEL] = randomUUID();
    await expect(f.run()).rejects.toThrow("being deleted"); expect(f.sandbox.process.executeCommand).not.toHaveBeenCalled();
  });
  it("rejects malformed ownership before accepting even stopped compute", async () => {
    const f = fixture(); f.sandbox.state = "stopped";
    f.input.owner.pid = 1; expect(await f.run()).toEqual({ state: "unverified" });
    expect(f.sandbox.refreshData).not.toHaveBeenCalled();
  });
  it("requires a bounded, exact and successful provider result", async () => {
    const f = fixture();
    for (const result of [{ exitCode: 1, result: '{"state":"running"}' }, { exitCode: 0, result: '{"state":"running","secret":"private"}' },
      { exitCode: 0, result: '{"state":"stopped"}' }, { exitCode: 0, result: "x".repeat(129) }, { exitCode: 0, result: "arbitrary provider output" }]) {
      f.sandbox.process.executeCommand.mockResolvedValueOnce(result); expect(await f.run()).toEqual({ state: "unverified" });
    }
  });
});
