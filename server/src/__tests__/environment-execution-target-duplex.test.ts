import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveEnvironmentDriverConfigForRuntime, mockResolvePluginSandboxProviderDriverById } =
  vi.hoisted(() => ({
    mockResolveEnvironmentDriverConfigForRuntime: vi.fn(),
    mockResolvePluginSandboxProviderDriverById: vi.fn(),
  }));

vi.mock("../services/environment-config.js", () => ({
  resolveEnvironmentDriverConfigForRuntime: mockResolveEnvironmentDriverConfigForRuntime,
}));

// The centralized duplex authorization gate resolves the exact lease capability
// snapshot before it calls the driver. The plugin branch of the snapshot reads
// the pinned plugin's declaration from the database. These service tests carry no
// database, so replace only the by-id declaration resolver. The test sets the
// resolved declaration per case; every other export stays real.
vi.mock("../services/plugin-environment-driver.js", async (importActual) => ({
  ...(await importActual<typeof import("../services/plugin-environment-driver.js")>()),
  resolvePluginSandboxProviderDriverById: mockResolvePluginSandboxProviderDriverById,
}));

import type { EffectiveExecutionCapabilities } from "@paperclipai/adapter-utils/execution-target";
import { createSshCommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/ssh";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { resolveEnvironmentExecutionTarget } from "../services/environment-execution-target.js";
import {
  buildSandboxCapabilityNarrowing,
  environmentRuntimeService,
} from "../services/environment-runtime.js";
import type {
  EnvironmentRuntimeDriver,
  EnvironmentRuntimeService,
} from "../services/environment-runtime.js";
import type {
  DuplexChannelHostSession,
  PluginWorkerManager,
} from "../services/plugin-worker-manager.js";

// A snapshot that grants the opt-in duplex capability, plus the rest true so the
// gate reads only the duplex flag.
const DUPLEX_GRANT: EffectiveExecutionCapabilities = {
  reusableLeases: true,
  nativeSyncIn: true,
  nativeSyncOut: true,
  persistentProcessSessions: true,
  independentControlCommands: true,
  incrementalSessionOutput: true,
  concurrentSyncOperations: true,
  duplexCommandStream: true,
  runnerWebSocketIngress: true,
};

const DUPLEX_ABSENT: EffectiveExecutionCapabilities = {
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

// A plugin driver declaration that grants the opt-in duplex capability. The
// centralized gate reads it through the by-id resolver and pairs it with the
// worker's verified `duplexChannelOpen` verb to grant the capability.
const DUPLEX_DECLARED_DRIVER = {
  plugin: {},
  driver: { sandboxCapabilities: { duplexCommandStream: true } },
};

// The fixed refusal the centralized gate throws when the lease does not grant the
// opt-in duplex capability.
const DUPLEX_DENIED = /does not grant the duplex command stream capability/;

beforeEach(() => {
  // The default resolves a clean sandbox config and a declaration that grants the
  // duplex capability, so the plugin lease reaches the worker. Each refusal test
  // overrides one input to deny the capability.
  mockResolveEnvironmentDriverConfigForRuntime.mockReset();
  mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
    driver: "sandbox",
    config: { provider: "daytona", timeoutMs: 30_000 },
  });
  mockResolvePluginSandboxProviderDriverById.mockReset();
  mockResolvePluginSandboxProviderDriverById.mockResolvedValue(DUPLEX_DECLARED_DRIVER);
});

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
    const inputBytes = new TextEncoder().encode("input-bytes");
    channel.write(inputBytes);
    expect(hostSession.write).toHaveBeenCalledWith(inputBytes);
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

  it("refuses a lease that is not a plugin-backed sandbox lease before it reaches the worker", async () => {
    const { manager, worker } = makeFakeWorkerManager();
    const service = environmentRuntimeService({} as never, { pluginWorkerManager: manager });
    const nonPluginLease = {
      id: "lease-2",
      companyId: "company-1",
      providerLeaseId: "provider-lease-2",
      metadata: { pluginId: "test.plugin", provider: "daytona" },
    } as unknown as EnvironmentLease;

    // The lease is not a plugin-backed sandbox lease, so the effective snapshot
    // never grants the opt-in duplex capability. The centralized gate refuses the
    // open before the driver, so the worker `duplexChannelOpen` RPC never runs.
    await expect(
      service.openDuplexChannel({
        environment: SANDBOX_ENVIRONMENT,
        lease: nonPluginLease,
        command: "bridge-callback",
      }),
    ).rejects.toThrow(DUPLEX_DENIED);
    expect(worker.openDuplexChannel).not.toHaveBeenCalled();
  });
});

// Direct regressions for the centralized authorization gate on
// EnvironmentRuntimeService.openDuplexChannel. The gate resolves the exact lease
// capability snapshot and refuses unless it grants the opt-in duplex capability.
// Every refusal must happen before the driver, so the worker `duplexChannelOpen`
// RPC never runs.
describe("EnvironmentRuntimeService.openDuplexChannel capability gate", () => {
  it("refuses a lease whose provider does not declare the duplex capability", async () => {
    const { manager, worker } = makeFakeWorkerManager();
    // The worker verifies the duplex verb, but the declaration omits the opt-in
    // capability. An opt-in capability needs an explicit declaration, so the
    // effective snapshot denies it.
    mockResolvePluginSandboxProviderDriverById.mockResolvedValue({ plugin: {}, driver: {} });
    const service = environmentRuntimeService({} as never, { pluginWorkerManager: manager });

    await expect(
      service.openDuplexChannel({
        environment: SANDBOX_ENVIRONMENT,
        lease: PLUGIN_LEASE,
        command: "bridge-callback",
      }),
    ).rejects.toThrow(DUPLEX_DENIED);
    expect(worker.openDuplexChannel).not.toHaveBeenCalled();
  });

  it("refuses a lease whose worker does not verify the duplex verb", async () => {
    const { manager, worker } = makeFakeWorkerManager();
    // The declaration grants the capability, but the worker does not advertise
    // the `duplexChannelOpen` verb, so the runtime never verified it. A
    // declaration never grants an unverified capability.
    worker.supportedMethods = [];
    const service = environmentRuntimeService({} as never, { pluginWorkerManager: manager });

    await expect(
      service.openDuplexChannel({
        environment: SANDBOX_ENVIRONMENT,
        lease: PLUGIN_LEASE,
        command: "bridge-callback",
      }),
    ).rejects.toThrow(DUPLEX_DENIED);
    expect(worker.openDuplexChannel).not.toHaveBeenCalled();
  });

  it("refuses a lease narrowed away from the duplex capability", async () => {
    // A fake driver returns a snapshot that grants every capability except the
    // duplex one, which models a lease narrowed away from it. The gate keys on
    // the exact duplex flag, so it refuses even though the other capabilities are
    // granted, and never calls the driver open.
    const openDuplexChannel = vi.fn();
    const narrowedDriver = {
      driver: "sandbox",
      acquireRunLease: vi.fn(),
      releaseRunLease: vi.fn(),
      resolveCapabilities: vi.fn(async () => ({ ...DUPLEX_ABSENT })),
      openDuplexChannel,
    } as unknown as EnvironmentRuntimeDriver;
    const service = environmentRuntimeService({} as never, { drivers: [narrowedDriver] });

    await expect(
      service.openDuplexChannel({
        environment: SANDBOX_ENVIRONMENT,
        lease: { ...PLUGIN_LEASE, metadata: { ...PLUGIN_LEASE.metadata, driver: "sandbox" } },
        command: "bridge-callback",
      }),
    ).rejects.toThrow(DUPLEX_DENIED);
    expect(openDuplexChannel).not.toHaveBeenCalled();
  });

  it("refuses a lease whose provider config fails to resolve", async () => {
    const { manager, worker } = makeFakeWorkerManager();
    // The declaration grants the capability and the worker verifies the verb, but
    // the provider config cannot be resolved. An untrusted provider fails closed,
    // so the config-resolution failure narrows the duplex capability away.
    mockResolveEnvironmentDriverConfigForRuntime.mockRejectedValue(new Error("config unresolved"));
    const service = environmentRuntimeService({} as never, { pluginWorkerManager: manager });

    await expect(
      service.openDuplexChannel({
        environment: SANDBOX_ENVIRONMENT,
        lease: PLUGIN_LEASE,
        command: "bridge-callback",
      }),
    ).rejects.toThrow(DUPLEX_DENIED);
    expect(worker.openDuplexChannel).not.toHaveBeenCalled();
  });

  it("narrows the duplex capability away when the provider config resolution fails", () => {
    // Unit cover for the narrowing rule the config-failure case relies on: a
    // failed config resolution fails closed on the opt-in duplex capability.
    const narrowing = buildSandboxCapabilityNarrowing({
      leasePolicy: "reuse_by_environment",
      leaseMetadata: {},
      configResolutionFailed: true,
    });
    expect(narrowing.duplexCommandStream).toBe(false);

    const granted = buildSandboxCapabilityNarrowing({
      leasePolicy: "reuse_by_environment",
      leaseMetadata: {},
      configResolutionFailed: false,
    });
    expect(granted.duplexCommandStream).toBeUndefined();
  });
});

// Build a sandbox execution target with a fixed capability snapshot and a fake
// environment runtime whose openDuplexChannel is a spy. The helper returns the
// runner and the spy so a test reads the capability-gated member.
async function buildSandboxRunner(input: {
  snapshot: EffectiveExecutionCapabilities | null;
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
    resolveCapabilities: vi.fn(async () =>
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
