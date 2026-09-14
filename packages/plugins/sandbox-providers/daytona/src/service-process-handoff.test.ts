import { randomUUID } from "node:crypto";
import type { Sandbox } from "@daytonaio/sdk";
import type { PluginEnvironmentProcessHandoffParams } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

// Provider unit tests use injected sandbox objects; the standalone SDK is not
// installed by the root workspace test command.
vi.mock("@daytonaio/sdk", () => ({ DaytonaNotFoundError: class extends Error {} }));
import { handleDaytonaProcessHandoff } from "./service-process-handoff.js";
import { SERVICE_DATA_DELETION_LABEL } from "./service-data-deletion.js";

function fixture() {
  const input: PluginEnvironmentProcessHandoffParams = {
    driverKey: "daytona", companyId: randomUUID(), environmentId: randomUUID(), providerLeaseId: randomUUID(),
    config: { apiKey: "fixture-provider-secret" }, workspaceConnection: { scopeId: randomUUID(), fingerprint: "b".repeat(64) },
    operation: { action: "capture", sourcePid: 42, owner: { version: 1, pid: 40, uid: 1000, processGroupId: 40, bootId: randomUUID(), startTicks: "11" }, cwd: "/workspace/project", workspaceRoot: "/workspace" },
  };
  const receipt = { version: 1, scope: { companyId: input.companyId, environmentId: input.environmentId, providerLeaseId: input.providerLeaseId },
    boot: { bootId: randomUUID(), initStartTicks: "10", uid: 1000 }, groupId: 42, leaderIdentity: "12", members: [{ pid: 42, identity: "12" }] };
  const captured = { state: "captured", key: "c".repeat(64), receipt };
  const sandbox = {
    id: input.providerLeaseId, state: "started", labels: { "paperclip-company-id": input.companyId, "paperclip-environment-id": input.environmentId } as Record<string, string>,
    refreshData: vi.fn(async () => {}), start: vi.fn(), stop: vi.fn(), delete: vi.fn(), setLabels: vi.fn(), setTtl: vi.fn(),
    setAutoDeleteInterval: vi.fn(), setAutostopInterval: vi.fn(), setAutoPauseInterval: vi.fn(),
    process: { executeCommand: vi.fn(async () => ({ exitCode: 0, result: JSON.stringify(captured) })) },
  };
  return { input, receipt, captured, sandbox, run: () => handleDaytonaProcessHandoff(sandbox as unknown as Sandbox, input) };
}

describe("Daytona existing-command handoff boundary", () => {
  it("captures through fixed code with only ownership metadata and no lifecycle changes", async () => {
    const f = fixture(); expect(await f.run()).toEqual(f.captured);
    const args = f.sandbox.process.executeCommand.mock.calls[0] as unknown as [string, string, Record<string, string>, number];
    expect(args[0]).toMatch(/^node -e /); expect(args[1]).toBe("/tmp"); expect(args[3]).toBe(15);
    expect(JSON.parse(args[2].PAPERCLIP_PROCESS_HANDOFF)).toEqual({ ...f.input.operation, scope: f.receipt.scope });
    expect(JSON.stringify(args)).not.toContain("fixture-provider-secret");
    for (const operation of [f.sandbox.start, f.sandbox.stop, f.sandbox.delete, f.sandbox.setLabels, f.sandbox.setTtl,
      f.sandbox.setAutoDeleteInterval, f.sandbox.setAutostopInterval, f.sandbox.setAutoPauseInterval]) expect(operation).not.toHaveBeenCalled();
  });
  it.each(["company", "environment", "sandbox"])("rejects freshly changed %s ownership before executing", async (kind) => {
    const f = fixture(); f.sandbox.refreshData.mockImplementationOnce(async () => {
      if (kind === "sandbox") f.sandbox.id = randomUUID(); else f.sandbox.labels[`paperclip-${kind}-id`] = randomUUID();
    });
    expect(await f.run()).toEqual({ state: "failed", errorCode: "PROCESS_OWNERSHIP_UNVERIFIED" });
    expect(f.sandbox.process.executeCommand).not.toHaveBeenCalled();
  });
  it("honors the persistent deletion fence", async () => {
    const f = fixture(); f.sandbox.labels[SERVICE_DATA_DELETION_LABEL] = randomUUID();
    await expect(f.run()).rejects.toThrow("being deleted"); expect(f.sandbox.process.executeCommand).not.toHaveBeenCalled();
  });
  it.each(["stopped", "archived"])("confirms stop in %s compute but cannot capture or wake it", async (state) => {
    const f = fixture(); f.sandbox.state = state;
    expect(await f.run()).toEqual({ state: "failed", errorCode: "PROCESS_HANDOFF_UNAVAILABLE" });
    f.input.operation = { action: "stop", receipt: f.receipt };
    expect(await f.run()).toEqual({ state: "stopped" });
    expect(f.sandbox.process.executeCommand).not.toHaveBeenCalled(); expect(f.sandbox.start).not.toHaveBeenCalled();
  });
  it.each(["starting", "stopping", "error", "destroyed"])("does not infer process termination from %s", async (state) => {
    const f = fixture(); f.sandbox.state = state; f.input.operation = { action: "stop", receipt: f.receipt };
    expect(await f.run()).toEqual({ state: "failed", errorCode: "PROCESS_HANDOFF_UNAVAILABLE" });
    expect(f.sandbox.process.executeCommand).not.toHaveBeenCalled();
  });
  it("refuses foreign and malformed stop receipts even when compute is stopped", async () => {
    const f = fixture(); f.sandbox.state = "stopped";
    for (const receipt of [{ ...f.receipt, scope: { ...f.receipt.scope, companyId: randomUUID() } }, { ...f.receipt, members: [...f.receipt.members, ...f.receipt.members] }, { ...f.receipt, command: "private-data" }, {}]) {
      f.input.operation = { action: "stop", receipt };
      expect(await f.run()).toEqual({ state: "failed", errorCode: "PROCESS_HANDOFF_UNVERIFIED" });
    }
    expect(f.sandbox.process.executeCommand).not.toHaveBeenCalled();
  });
  it("requires an exact successful stop response before permitting a replacement", async () => {
    const f = fixture(); f.input.operation = { action: "stop", receipt: f.receipt };
    for (const result of [{ exitCode: 1, result: '{"state":"stopped"}' }, { exitCode: 0, result: '{"state":"captured"}' }, { exitCode: 0, result: '{"state":"stopped","secret":"private-data"}' }]) {
      f.sandbox.process.executeCommand.mockResolvedValueOnce(result);
      expect(await f.run()).toEqual({ state: "failed", errorCode: "PROCESS_HANDOFF_UNVERIFIED" });
    }
    f.sandbox.process.executeCommand.mockResolvedValueOnce({ exitCode: 0, result: '{"state":"stopped"}' });
    expect(await f.run()).toEqual({ state: "stopped" }); expect(f.sandbox.stop).not.toHaveBeenCalled();
  });
  it("rejects malformed capture output without exposing arbitrary provider output", async () => {
    const f = fixture();
    for (const result of ["private-data", JSON.stringify({ ...f.captured, secret: "private-data" }), JSON.stringify({ ...f.captured, receipt: { ...f.receipt, scope: {} } }), "x".repeat(128 * 1024 + 1)]) {
      f.sandbox.process.executeCommand.mockResolvedValueOnce({ exitCode: 0, result });
      expect(await f.run()).toEqual({ state: "failed", errorCode: "PROCESS_OWNERSHIP_UNVERIFIED" });
    }
  });
});
