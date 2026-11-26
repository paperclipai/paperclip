import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { RunnerIngressEndpoint } from "@paperclipai/adapter-utils/runner-connectivity";
import { createNativeRunnerExecutionDriver } from "./native-runner-execution-driver.js";

const transport = vi.hoisted(() => ({
  register: vi.fn(),
  connect: vi.fn(),
}));
vi.mock("../../realtime/runner-prp-ws.js", () => ({ registerRunnerPrpAuthority: transport.register }));
vi.mock("../../realtime/runner-prp-outbound.js", () => ({ connectRunnerPrpIngress: transport.connect }));

const binding = { companyId: "company", issueId: "issue", agentId: "agent", runId: "run-a" };
const authority = {} as Parameters<NonNullable<ReturnType<typeof createNativeRunnerExecutionDriver>["controlPlaneRegistration"]>>[0];
const ssh = { kind: "remote", transport: "ssh", remoteCwd: "/workspace", spec: {} } as AdapterExecutionTarget;
const sandbox = (ingress = true): AdapterExecutionTarget => ({
  kind: "remote", transport: "sandbox", remoteCwd: "/workspace", leaseId: "lease",
  effectiveCapabilities: { runnerWebSocketIngress: ingress },
} as AdapterExecutionTarget);

function endpoint(): RunnerIngressEndpoint {
  return {
    kind: "authenticated_websocket", websocketUrl: "wss://sandbox.example/runner",
    secretHeaders: [{ name: "Authorization", value: "test-ingress-secret" }], generation: "1",
    refresh: vi.fn(), close: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  transport.register.mockResolvedValue({ connectUrl: "ws://127.0.0.1/core", release: vi.fn() });
  transport.connect.mockReturnValue({ ready: Promise.resolve(), close: vi.fn(async () => {}) });
});

describe("shared Runner execution driver", () => {
  it("keeps local execution on the registered loopback route", async () => {
    const driver = createNativeRunnerExecutionDriver({ target: { kind: "local" }, binding });
    const connection = await driver.controlPlaneRegistration!(authority);
    expect(connection.connectUrl).toBe("ws://127.0.0.1/core");
    expect(connection.startupFailureCode).toBe("runner_local_connect_failed");
    expect(transport.register).toHaveBeenCalledWith({ ...binding, authority });
    expect(transport.connect).not.toHaveBeenCalled();
  });

  it.each([ssh, sandbox(false)])("prepares $transport before launching an outbound Runner", async target => {
    const prepare = vi.fn(async () => {});
    const launch = vi.fn();
    const read = vi.fn();
    const checkpoint = vi.fn();
    const mapCaBundle = vi.fn(async () => "/remote/ca.pem");
    const driver = createNativeRunnerExecutionDriver({
      target, binding, runnerPublicUrl: "wss://core.example", prepareRemote: prepare,
      process: { runnerProcessLauncher: launch, readRunnerState: read }, checkpoint, mapCaBundle,
    });
    const connection = await driver.controlPlaneRegistration!(authority);
    expect(prepare).toHaveBeenCalledWith("dial_wss");
    expect(connection.connection).toEqual({ mode: "connect", connectUrl: "wss://core.example/api/runner/v1/connect/run-a" });
    expect(connection.checkpoint).toBe(checkpoint);
    expect(driver.runnerProcessLauncher).toBe(launch);
    expect(driver.readRunnerState).toBe(read);
    expect(launch).not.toHaveBeenCalled();
    expect(mapCaBundle).not.toHaveBeenCalled();
    expect(transport.connect).not.toHaveBeenCalled();
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(transport.register.mock.invocationCallOrder[0]);
  });

  it("rejects invalid outbound connectivity before staging resources", async () => {
    const prepare = vi.fn();
    const driver = createNativeRunnerExecutionDriver({ target: ssh, binding, prepareRemote: prepare });
    await expect(driver.controlPlaneRegistration!(authority)).rejects.toThrow("runner_transport_ineligible");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects a missing CA file before preparing the remote environment", async () => {
    const prepare = vi.fn();
    const driver = createNativeRunnerExecutionDriver({
      target: ssh, binding, prepareRemote: prepare, runnerPublicUrl: "wss://core.example",
      runnerCaBundlePath: "/nonexistent/paperclip-runner-test-ca.pem",
    });
    await expect(driver.controlPlaneRegistration!(authority)).rejects.toThrow("runner_direct_wss_failed");
    expect(prepare).not.toHaveBeenCalled();
    expect(transport.register).not.toHaveBeenCalled();
  });

  it("binds an outbound CA to the process owner's filesystem", async () => {
    const mapCaBundle = vi.fn(async () => "/remote/ca.pem");
    const driver = createNativeRunnerExecutionDriver({
      target: ssh, binding, prepareRemote: async () => {}, runnerPublicUrl: "wss://core.example",
      runnerCaBundlePath: process.execPath, mapCaBundle,
    });
    const connection = await driver.controlPlaneRegistration!(authority);
    expect(mapCaBundle).toHaveBeenCalledWith(process.execPath);
    expect(connection.connection).toEqual(expect.objectContaining({ caBundlePath: "/remote/ca.pem" }));
    expect(mapCaBundle.mock.invocationCallOrder[0]).toBeLessThan(transport.register.mock.invocationCallOrder[0]);
  });

  it("does not register an authority route when CA staging fails", async () => {
    const driver = createNativeRunnerExecutionDriver({
      target: ssh, binding, prepareRemote: async () => {}, runnerPublicUrl: "wss://core.example",
      runnerCaBundlePath: process.execPath,
      mapCaBundle: async () => { throw new Error("ca_copy_failed"); },
    });
    await expect(driver.controlPlaneRegistration!(authority)).rejects.toThrow("ca_copy_failed");
    expect(transport.register).not.toHaveBeenCalled();
  });

  it("stages before acquiring ingress and waits for process dispatch before connecting", async () => {
    const ingress = endpoint();
    const acquire = vi.fn(async () => ingress);
    const prepare = vi.fn(async () => {});
    let started!: () => void;
    const processStarted = new Promise<void>(resolve => { started = resolve; });
    const driver = createNativeRunnerExecutionDriver({
      target: { ...sandbox(), getRunnerIngressEndpoint: acquire } as AdapterExecutionTarget,
      binding, runnerIngressAuthorized: true, prepareRemote: prepare, processStarted,
    });
    const connection = await driver.controlPlaneRegistration!(authority);
    expect(prepare).toHaveBeenCalledWith("listen_ws");
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(acquire.mock.invocationCallOrder[0]);
    expect(connection.connection?.mode).toBe("listen");
    await connection.activate!();
    expect(transport.connect).not.toHaveBeenCalled();
    started();
    await connection.ready!();
    expect(transport.connect).toHaveBeenCalledWith(expect.objectContaining({ authority, endpoint: ingress }));
    expect(transport.register).not.toHaveBeenCalled();
    await connection.release();
    expect(transport.connect.mock.results[0].value.close).toHaveBeenCalledOnce();
  });

  it("does not fall back to outbound WSS when sandbox ingress is unauthorized", async () => {
    const prepare = vi.fn();
    const acquire = vi.fn();
    const driver = createNativeRunnerExecutionDriver({
      target: { ...sandbox(), getRunnerIngressEndpoint: acquire } as AdapterExecutionTarget,
      binding, runnerPublicUrl: "wss://core.example", prepareRemote: prepare,
    });
    await expect(driver.controlPlaneRegistration!(authority)).rejects.toThrow("runner_ingress_unavailable");
    expect(prepare).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(transport.register).not.toHaveBeenCalled();
  });

  it("closes acquired ingress when setup ends before activation", async () => {
    const ingress = endpoint();
    const driver = createNativeRunnerExecutionDriver({
      target: { ...sandbox(), getRunnerIngressEndpoint: async () => ingress } as AdapterExecutionTarget,
      binding, runnerIngressAuthorized: true, prepareRemote: async () => {}, processStarted: Promise.resolve(),
    });
    const connection = await driver.controlPlaneRegistration!(authority);
    await connection.release();
    expect(ingress.close).toHaveBeenCalledOnce();
    expect(transport.connect).not.toHaveBeenCalled();
  });

  it("uses the newly authorized run binding during warm registration", async () => {
    const beforeConnect = vi.fn(async () => {});
    const identity = { runId: "run-b" } as Parameters<NonNullable<ReturnType<typeof createNativeRunnerExecutionDriver>["controlPlaneRegistration"]>>[1];
    const driver = createNativeRunnerExecutionDriver({ target: { kind: "local" }, binding, beforeConnect });
    await driver.controlPlaneRegistration!(authority, identity);
    expect(beforeConnect).toHaveBeenCalledWith(identity);
    expect(transport.register).toHaveBeenCalledWith({ ...binding, runId: "run-b", authority });
    expect(beforeConnect.mock.invocationCallOrder[0]).toBeLessThan(transport.register.mock.invocationCallOrder[0]);
  });

  it("blocks registration if warm recovery authority is no longer valid", async () => {
    const driver = createNativeRunnerExecutionDriver({
      target: { kind: "local" }, binding,
      beforeConnect: async () => { throw new Error("recovery_denied"); },
    });
    await expect(driver.controlPlaneRegistration!(authority)).rejects.toThrow("recovery_denied");
    expect(transport.register).not.toHaveBeenCalled();
  });

  it("requires exact process identity before admitting an external provider", async () => {
    const driver = createNativeRunnerExecutionDriver({
      target: ssh, binding, runnerPublicUrl: "wss://core.example", prepareRemote: async () => {},
      processIdentityReady: Promise.reject(new Error("process_identity_invalid")),
    });
    const connection = await driver.controlPlaneRegistration!(authority);
    await expect(connection.ready!()).rejects.toThrow("process_identity_invalid");
  });
});
