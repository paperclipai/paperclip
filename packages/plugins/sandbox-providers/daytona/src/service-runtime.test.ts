import { randomUUID } from "node:crypto";
import type { Sandbox } from "@daytonaio/sdk";
import type { PluginEnvironmentServiceParams } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

// Provider unit tests use injected sandbox objects; the standalone SDK is not
// installed by the root workspace test command.
vi.mock("@daytonaio/sdk", () => ({ DaytonaNotFoundError: class extends Error {} }));
import { assertDaytonaSandboxNotRetained, handleDaytonaServiceOperation, SERVICE_RETENTION_LABEL } from "./service-runtime.js";

function fixture() {
  const input: PluginEnvironmentServiceParams = {
    driverKey: "daytona", companyId: randomUUID(), environmentId: randomUUID(), providerLeaseId: randomUUID(),
    config: {}, serviceId: randomUUID(), generation: randomUUID(), action: "start",
    launch: { command: "node app.cjs", cwd: "/workspace", env: { APP_SECRET: "secret-value" }, secretKeys: ["APP_SECRET"], endpoints: [{ name: "web", portEnv: "PORT", healthPath: "/" }] },
  };
  const sandbox = {
    id: input.providerLeaseId, state: "started", labels: { "paperclip-company-id": input.companyId, "paperclip-environment-id": input.environmentId } as Record<string, string>,
    refreshData: vi.fn(async () => {}), setAutoDeleteInterval: vi.fn(async () => {}), setTtl: vi.fn(async () => {}),
    setAutostopInterval: vi.fn(async () => {}), setAutoPauseInterval: vi.fn(async () => {}),
    setLabels: vi.fn(async (labels: Record<string, string>) => { sandbox.labels = labels; return labels; }),
    stop: vi.fn(async () => { sandbox.state = "stopped"; }), start: vi.fn(async () => { sandbox.state = "started"; }),
    delete: vi.fn(),
    process: { executeCommand: vi.fn(async () => ({ exitCode: 0, result: JSON.stringify({ state: "running", processRef: { generation: input.generation }, endpoints: [{ name: "web", port: 5173, healthy: true }] }) })) },
    getPreviewLink: vi.fn(async (port: number) => ({ url: `https://${port}-${input.providerLeaseId}.proxy.daytona.work`, token: "private-preview-token" })),
  };
  const run = () => handleDaytonaServiceOperation(sandbox as unknown as Sandbox, input);
  return { input, sandbox, run };
}
describe("Daytona managed service boundary", () => {
  it.each(["", "node: command not found", "null", "[]", "{}"]) ("returns a bounded failure for invalid controller output %j", async output => {
    const f = fixture();
    for (const exitCode of [0, 1]) {
      for (const action of ["stop", "inspect", "logs", "endpoint"] as const) {
        f.input.action = action;
        f.sandbox.process.executeCommand.mockResolvedValueOnce({ exitCode, result: output });
        await expect(f.run()).resolves.toEqual({ state: "missing", errorCode: "SERVICE_OPERATION_FAILED" });
      }
    }
    expect(f.sandbox.getPreviewLink).not.toHaveBeenCalled();
  });
  it("preserves a known controller failure and rejects malformed storage output", async () => {
    const f = fixture();
    f.sandbox.process.executeCommand.mockResolvedValueOnce({ exitCode: 1, result: JSON.stringify({ error: "IDENTITY_LOST" }) });
    await expect(f.run()).resolves.toEqual({ state: "missing", errorCode: "IDENTITY_LOST" });
    f.input.action = "storage_usage";
    f.sandbox.process.executeCommand.mockResolvedValueOnce({ exitCode: 0, result: "invalid JSON" });
    await expect(f.run()).resolves.toMatchObject({ storageUsage: { unavailable: "measurement_failed" } });
  });
  it("rejects mismatched resources before starting or exposing an application", async () => {
    const f = fixture(); f.input.config = { cpu: 4, memory: 8, disk: 20 };
    Object.assign(f.sandbox, { cpu: 4, memory: 16, disk: 20 }); f.sandbox.state = "stopped";
    for (const action of ["start", "inspect", "endpoint"] as const) {
      f.input.action = action;
      expect(await f.run()).toMatchObject({ errorCode: "RESOURCE_CONFIGURATION_MISMATCH", endpoints: [] });
    }
    expect(f.sandbox.start).not.toHaveBeenCalled(); expect(f.sandbox.process.executeCommand).not.toHaveBeenCalled();
    expect(f.sandbox.getPreviewLink).not.toHaveBeenCalled(); expect(f.sandbox.setLabels).not.toHaveBeenCalled();
    f.input.action = "stop"; await expect(f.run()).resolves.toMatchObject({ state: "exited" });
    f.input.action = "retain"; await expect(f.run()).resolves.toMatchObject({ state: "retained" });
    f.input.action = "release_compute"; await expect(f.run()).resolves.toMatchObject({ state: "stopped" });
    expect(f.sandbox.delete).not.toHaveBeenCalled();
  });
  it("rechecks resource allocation after waking retained compute", async () => {
    const f = fixture(); f.input.config = { cpu: 4, memory: 8 }; Object.assign(f.sandbox, { cpu: 4, memory: 8 });
    f.sandbox.state = "stopped";
    f.sandbox.start.mockImplementationOnce(async () => { f.sandbox.state = "started"; Object.assign(f.sandbox, { memory: 16 }); });
    expect(await f.run()).toMatchObject({ state: "running", errorCode: "RESOURCE_CONFIGURATION_MISMATCH" });
    expect(f.sandbox.start).toHaveBeenCalledOnce(); expect(f.sandbox.process.executeCommand).not.toHaveBeenCalled();
    expect(f.sandbox.labels[SERVICE_RETENTION_LABEL]).toBe("true");
  });
  it("launches with matching resources and detects a later provider resize without blocking Stop", async () => {
    const f = fixture(); f.input.config = { cpu: 4, memory: 8 }; Object.assign(f.sandbox, { cpu: 4, memory: 8 });
    expect(await f.run()).toMatchObject({ state: "running" });
    Object.assign(f.sandbox, { cpu: 8 }); f.input.action = "inspect";
    expect(await f.run()).toMatchObject({ errorCode: "RESOURCE_CONFIGURATION_MISMATCH" });
    f.input.action = "stop"; f.sandbox.process.executeCommand.mockResolvedValueOnce({ exitCode: 0, result: JSON.stringify({ state: "exited" }) });
    expect(await f.run()).toMatchObject({ state: "exited" });
    expect(f.sandbox.delete).not.toHaveBeenCalled();
  });
  it("measures a running workspace without app secrets or lifetime changes", async () => {
    const f = fixture(); f.input.action = "storage_usage";
    f.sandbox.process.executeCommand.mockResolvedValueOnce({ exitCode: 0, result: JSON.stringify({ bytes: 8192 }) });
    expect(await f.run()).toMatchObject({ storageUsage: { bytes: 8192 } });
    const [command, , env] = f.sandbox.process.executeCommand.mock.calls[0] as unknown as [string, string, Record<string, string>];
    expect(command).not.toContain("secret-value"); expect(env).toEqual({});
    expect(f.sandbox.start).not.toHaveBeenCalled(); expect(f.sandbox.setLabels).not.toHaveBeenCalled();
  });
  it.each(["stopped", "archived"])("never wakes %s compute for a storage measurement", async (state) => {
    const f = fixture(); f.input.action = "storage_usage"; f.sandbox.state = state;
    expect(await f.run()).toMatchObject({ storageUsage: { unavailable: "compute_stopped" } });
    expect(f.sandbox.start).not.toHaveBeenCalled(); expect(f.sandbox.process.executeCommand).not.toHaveBeenCalled();
  });
  it("does not claim that transitioning compute is stopped", async () => {
    const f = fixture(); f.input.action = "storage_usage"; f.sandbox.state = "starting";
    expect(await f.run()).toMatchObject({ state: "retained", storageUsage: { unavailable: "measurement_failed" } });
    expect(f.sandbox.start).not.toHaveBeenCalled(); expect(f.sandbox.process.executeCommand).not.toHaveBeenCalled();
  });
  it("retains filesystem and compute before starting outside an agent session", async () => {
    const f = fixture();
    await f.run();
    expect(f.sandbox.setAutoDeleteInterval).toHaveBeenCalledWith(-1);
    expect(f.sandbox.setAutostopInterval).toHaveBeenCalledWith(0);
    expect(f.sandbox.setTtl).toHaveBeenCalledWith(0);
    expect(f.sandbox.labels[SERVICE_RETENTION_LABEL]).toBe("true");
    const args = f.sandbox.process.executeCommand.mock.calls[0] as unknown as [string, string, Record<string, string>, number];
    expect(args[0]).not.toContain("secret-value");
    expect(JSON.parse(args[2].PAPERCLIP_SERVICE_CONTROL).launch.env.APP_SECRET).toBe("secret-value");
  });
  it("rejects foreign sandbox labels before executing or exposing ports", async () => {
    const f = fixture(); f.sandbox.labels["paperclip-company-id"] = randomUUID();
    await expect(f.run()).rejects.toThrow("ownership labels");
    expect(f.sandbox.process.executeCommand).not.toHaveBeenCalled();
  });
  it("returns a private upstream only for a verified process endpoint", async () => {
    const f = fixture(); f.input.action = "endpoint"; f.input.endpointName = "web";
    expect((await f.run()).upstream).toMatchObject({ headers: { "x-daytona-preview-token": "private-preview-token", "x-daytona-disable-cors": "true", "x-daytona-trust-forwarded-host": "true", "x-daytona-skip-last-activity-update": "true" } });
    f.input.endpointName = "runner";
    await expect(f.run()).rejects.toThrow("not healthy or owned");
    expect(f.sandbox.getPreviewLink).toHaveBeenCalledTimes(1);
  });
  it("protects retained allocations from legacy teardown and never deletes on stop failure", async () => {
    const f = fixture(); f.sandbox.labels[SERVICE_RETENTION_LABEL] = "true";
    await expect(assertDaytonaSandboxNotRetained(f.sandbox as unknown as Sandbox)).rejects.toThrow("retained by runtime services");
    f.input.action = "release_compute";
    f.sandbox.stop.mockRejectedValueOnce(new Error("stop timeout"));
    await expect(f.run()).rejects.toThrow("stop timeout");
    expect(f.sandbox.delete).not.toHaveBeenCalled();
  });
  it("records an explicit stop even while a sandbox is asleep", async () => {
    const f = fixture(); f.input.action = "stop"; f.sandbox.state = "stopped";
    expect(await f.run()).toMatchObject({ state: "exited" });
    f.input.action = "start";
    expect(await f.run()).toMatchObject({ state: "exited" });
    expect(f.sandbox.start).not.toHaveBeenCalled();
  });
});
