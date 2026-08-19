import { describe, expect, it, vi } from "vitest";

const { mockResolveEnvironmentDriverConfigForRuntime } = vi.hoisted(() => ({
  mockResolveEnvironmentDriverConfigForRuntime: vi.fn(),
}));

vi.mock("../services/environment-config.js", () => ({
  resolveEnvironmentDriverConfigForRuntime: mockResolveEnvironmentDriverConfigForRuntime,
}));

import type { EffectiveSandboxCapabilities } from "@paperclipai/adapter-utils/execution-target";
import { createSshCommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/ssh";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { resolveEnvironmentExecutionTarget } from "../services/environment-execution-target.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import type { EnvironmentRuntimeService } from "../services/environment-runtime.js";
import type {
  DuplexChannelHostSession,
  PluginWorkerManager,
} from "../services/plugin-worker-manager.js";

// A snapshot that grants the opt-in duplex capability, plus the rest true so the
// gate reads only the duplex flag.
const DUPLEX_GRANT: EffectiveSandboxCapabilities = {
  reusableLeases: true,
  nativeSyncIn: true,
  nativeSyncOut: true,
  persistentProcessSessions: true,
  independentControlCommands: true,
  incrementalSessionOutput: true,
  duplexCommandStream: true,
};

const DUPLEX_ABSENT: EffectiveSandboxCapabilities = {
  ...DUPLEX_GRANT,
  duplexCommandStream: false,
};

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// A fake worker manager whose one worker returns a controllable host session.
// The session records every host→worker call and lets the test settle the exit.
function makeFakeWorkerManager() {
  let settleWait: (value: { exitCode: number | null }) => void = () => {};
  const waitPromise = new Promise<{ exitCode: number | null }>((resolve) => {
    settleWait = resolve;
  });
  const hostSession = {
    onData: vi.fn(),
    write: vi.fn(),
    wait: vi.fn(() => waitPromise),
    kill: vi.fn(),
    close: vi.fn(async () => {}),
  } satisfies DuplexChannelHostSession;
  const openDuplexChannel = vi.fn(async () => hostSession);
  const worker = { openDuplexChannel, supportedMethods: ["duplexChannelOpen"] };
  const manager = {
    getWorker: vi.fn(() => worker),
  } as unknown as PluginWorkerManager;
  return { manager, worker, hostSession, openDuplexChannel, settleWait };
}

const PLUGIN_LEASE: EnvironmentLease = {
  id: "lease-1",
  companyId: "company-1",
  providerLeaseId: "provider-lease-1",
  metadata: {
    sandboxProviderPlugin: true,
    pluginId: "test.plugin",
    provider: "daytona",
  },
} as unknown as EnvironmentLease;

const SANDBOX_ENVIRONMENT: Environment = {
  id: "env-1",
  driver: "sandbox",
} as unknown as Environment;

describe("sandbox driver duplex channel wiring", () => {
  it("reaches the worker manager route with the lease scope and delegates the channel members", async () => {
    const { manager, worker, hostSession, settleWait } = makeFakeWorkerManager();
    const service = environmentRuntimeService({} as never, { pluginWorkerManager: manager });

    const channel = await service.openDuplexChannel({
      environment: SANDBOX_ENVIRONMENT,
      lease: PLUGIN_LEASE,
      command: "bridge-callback",
    });

    // The driver resolves the worker by the pinned plugin id and passes the same
    // lease scope the sandbox execute path uses.
    expect(manager.getWorker).toHaveBeenCalledWith("test.plugin");
    expect(worker.openDuplexChannel).toHaveBeenCalledWith({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "provider-lease-1",
      command: "bridge-callback",
    });

    // write / stop / close map to write / kill / close on the host session.
    channel.write("input-bytes");
    expect(hostSession.write).toHaveBeenCalledWith("input-bytes");
    channel.stop();
    expect(hostSession.kill).toHaveBeenCalledTimes(1);
    await channel.close();
    expect(hostSession.close).toHaveBeenCalledTimes(1);

    // onData maps one to one.
    const dataListener = vi.fn();
    channel.onData(dataListener);
    expect(hostSession.onData).toHaveBeenCalledWith(dataListener);

    // onExit bridges the host session's one-time wait() to the exit listener.
    const exitListener = vi.fn();
    channel.onExit(exitListener);
    expect(exitListener).not.toHaveBeenCalled();
    settleWait({ exitCode: 7 });
    await flushMicrotasks();
    expect(exitListener).toHaveBeenCalledWith({ exitCode: 7 });
  });

  it("throws when the lease is not a plugin-backed sandbox lease", async () => {
    const { manager } = makeFakeWorkerManager();
    const service = environmentRuntimeService({} as never, { pluginWorkerManager: manager });
    const nonPluginLease = {
      id: "lease-2",
      companyId: "company-1",
      providerLeaseId: "provider-lease-2",
      metadata: { pluginId: "test.plugin", provider: "daytona" },
    } as unknown as EnvironmentLease;

    await expect(
      service.openDuplexChannel({
        environment: SANDBOX_ENVIRONMENT,
        lease: nonPluginLease,
        command: "bridge-callback",
      }),
    ).rejects.toThrow(/does not support duplex channels/);
  });
});

// Build a sandbox execution target with a fixed capability snapshot and a fake
// environment runtime whose openDuplexChannel is a spy. The helper returns the
// runner and the spy so a test reads the capability-gated member.
async function buildSandboxRunner(input: {
  snapshot: EffectiveSandboxCapabilities | null;
}) {
  mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
    driver: "sandbox",
    config: { provider: "daytona", timeoutMs: 30_000 },
  });

  const openDuplexChannel = vi.fn(async () => ({
    write: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    stop: vi.fn(),
    close: vi.fn(async () => {}),
  }));
  const environmentRuntime = {
    execute: vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "ok",
      stderr: "",
      metadata: {},
    }),
    supportsSync: () => false,
    syncIn: vi.fn(),
    syncOut: vi.fn(),
    openDuplexChannel,
    effectiveSandboxCapabilities: vi.fn(async () =>
      input.snapshot ? Object.freeze({ ...input.snapshot }) : null,
    ),
  } as unknown as EnvironmentRuntimeService;

  const target = await resolveEnvironmentExecutionTarget({
    db: {} as never,
    companyId: "company-1",
    adapterType: "codex_local",
    environment: { id: "env-1", driver: "sandbox", config: { provider: "daytona" } },
    leaseId: "lease-1",
    leaseMetadata: { remoteCwd: "/work" },
    lease: { id: "lease-1", leasePolicy: "reuse_by_environment" } as never,
    environmentRuntime,
  });
  if (!target || target.kind !== "remote" || target.transport !== "sandbox") {
    throw new Error("expected a sandbox execution target");
  }
  return { runner: target.runner, openDuplexChannel };
}

describe("inline sandbox runner duplex capability gate", () => {
  it("exposes openDuplexChannel that delegates to the runtime when the capability is granted", async () => {
    const { runner, openDuplexChannel } = await buildSandboxRunner({ snapshot: DUPLEX_GRANT });
    expect(runner?.openDuplexChannel).toBeDefined();

    await runner!.openDuplexChannel!({ command: "bridge-callback" });
    expect(openDuplexChannel).toHaveBeenCalledWith({
      environment: expect.objectContaining({ id: "env-1" }),
      lease: expect.objectContaining({ id: "lease-1" }),
      command: "bridge-callback",
    });
  });

  it("omits openDuplexChannel when the capability is absent", async () => {
    const { runner } = await buildSandboxRunner({ snapshot: DUPLEX_ABSENT });
    expect(runner?.openDuplexChannel).toBeUndefined();
  });

  it("omits openDuplexChannel when the capability snapshot is null", async () => {
    const { runner } = await buildSandboxRunner({ snapshot: null });
    expect(runner?.openDuplexChannel).toBeUndefined();
  });
});

describe("ssh runner factory", () => {
  it("omits openDuplexChannel", () => {
    const runner = createSshCommandManagedRuntimeRunner({
      spec: { remoteCwd: "/work" } as never,
    });
    expect(runner.openDuplexChannel).toBeUndefined();
  });
});
