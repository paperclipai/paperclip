import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveEnvironmentDriverConfigForRuntime } = vi.hoisted(() => ({
  mockResolveEnvironmentDriverConfigForRuntime: vi.fn(),
}));

vi.mock("../services/environment-config.js", () => ({
  resolveEnvironmentDriverConfigForRuntime: mockResolveEnvironmentDriverConfigForRuntime,
}));

import type { EffectiveSandboxCapabilities } from "@paperclipai/adapter-utils/execution-target";
import { resolveEnvironmentExecutionTarget } from "../services/environment-execution-target.js";
import type { EnvironmentRuntimeService } from "../services/environment-runtime.js";

const SNAPSHOT: EffectiveSandboxCapabilities = {
  reusableLeases: true,
  nativeSyncIn: true,
  nativeSyncOut: false,
  persistentProcessSessions: true,
  independentControlCommands: false,
  incrementalSessionOutput: false,
  // Concurrent sync operations need BOTH sync verbs; this snapshot verified only
  // inbound sync, so the opt-in stays off.
  concurrentSyncOperations: false,
  duplexCommandStream: false,
};

// A snapshot that grants every capability. A test overrides one flag to prove
// that the removed capability alone changes the runtime decision.
const FULL_GRANT: EffectiveSandboxCapabilities = {
  reusableLeases: true,
  nativeSyncIn: true,
  nativeSyncOut: true,
  persistentProcessSessions: true,
  independentControlCommands: true,
  incrementalSessionOutput: true,
  concurrentSyncOperations: true,
  duplexCommandStream: true,
};

// Build a sandbox execution target with a fixed snapshot and a fixed
// `supportsSync` result. The helper returns the sandbox target so a test reads
// the runner and the streaming flag the snapshot gates.
async function buildSandboxTarget(input: {
  snapshot: EffectiveSandboxCapabilities | null;
  supportsSync: boolean;
  config?: Record<string, unknown>;
  // Reject the capability resolution to exercise the fail-closed error path.
  rejectResolution?: boolean;
}) {
  mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
    driver: "sandbox",
    config: { provider: "daytona", timeoutMs: 30_000, ...(input.config ?? {}) },
  });

  const execute = vi.fn().mockResolvedValue({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "ok",
    stderr: "",
    metadata: { durationMs: 600, getDurationMs: 15 },
  });
  const environmentRuntime = {
    execute,
    supportsSync: () => input.supportsSync,
    syncIn: vi.fn(),
    syncOut: vi.fn(),
    effectiveSandboxCapabilities: vi.fn(async () => {
      if (input.rejectResolution) {
        throw new Error("capability resolution failed");
      }
      return input.snapshot ? Object.freeze({ ...input.snapshot }) : null;
    }),
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

  if (target?.kind !== "remote" || target.transport !== "sandbox") {
    throw new Error("expected a sandbox target");
  }
  return { target, execute };
}

describe("resolveEnvironmentExecutionTarget effective capability snapshot", () => {
  beforeEach(() => {
    mockResolveEnvironmentDriverConfigForRuntime.mockReset();
  });

  it("test_execution_target_carries_read_only_effective_snapshot", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: { provider: "daytona", reuseLease: true, timeoutMs: 30_000 },
    });

    const effectiveSandboxCapabilities = vi.fn(async () => Object.freeze({ ...SNAPSHOT }));
    const environmentRuntime = {
      supportsSync: () => false,
      effectiveSandboxCapabilities,
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

    expect(target?.kind).toBe("remote");
    if (target?.kind !== "remote" || target.transport !== "sandbox") {
      throw new Error("expected a sandbox target");
    }
    expect(effectiveSandboxCapabilities).toHaveBeenCalledTimes(1);
    expect(target.effectiveCapabilities).toEqual(SNAPSHOT);

    // The snapshot is read-only: it is frozen, so a write does not change it.
    expect(Object.isFrozen(target.effectiveCapabilities)).toBe(true);
    const snapshot = target.effectiveCapabilities as EffectiveSandboxCapabilities;
    try {
      (snapshot as { reusableLeases: boolean }).reusableLeases = false;
    } catch {
      // A strict-mode assignment throws; a non-strict one is a silent no-op.
    }
    expect(snapshot.reusableLeases).toBe(true);
  });

  it("omits the snapshot when no environment runtime resolves it", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: { provider: "daytona", reuseLease: false, timeoutMs: 30_000 },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: { id: "env-1", driver: "sandbox", config: { provider: "daytona" } },
      leaseId: "lease-1",
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    });

    expect(target?.kind).toBe("remote");
    if (target?.kind !== "remote" || target.transport !== "sandbox") {
      throw new Error("expected a sandbox target");
    }
    expect(target.effectiveCapabilities).toBeUndefined();
  });
});

describe("effective snapshot gates the sync decision", () => {
  beforeEach(() => {
    mockResolveEnvironmentDriverConfigForRuntime.mockReset();
  });

  it("exposes the native sync hooks when the snapshot grants both sync verbs", async () => {
    const { target } = await buildSandboxTarget({ snapshot: FULL_GRANT, supportsSync: true });
    expect(target.runner?.syncIn).toBeTypeOf("function");
    expect(target.runner?.syncOut).toBeTypeOf("function");
  });

  it("omits the native sync hooks when the snapshot removes a sync verb", async () => {
    // The snapshot verified inbound sync but not outbound sync. The runner
    // exposes the sync hooks both-or-neither, so it keeps the base64 fallback.
    const { target } = await buildSandboxTarget({
      snapshot: { ...FULL_GRANT, nativeSyncOut: false },
      supportsSync: true,
    });
    expect(target.runner?.syncIn).toBeUndefined();
    expect(target.runner?.syncOut).toBeUndefined();
  });

  it("still requires supportsSync even when the snapshot grants native sync", async () => {
    const { target } = await buildSandboxTarget({ snapshot: FULL_GRANT, supportsSync: false });
    expect(target.runner?.syncIn).toBeUndefined();
    expect(target.runner?.syncOut).toBeUndefined();
  });
});

// The execution target carries the concurrent-sync opt-in on both the effective
// snapshot and the runner. The runner Boolean feeds the sync client, which then
// tells the orchestrator whether it may run sync operations concurrently.
describe("effective snapshot carries the concurrent-sync capability", () => {
  beforeEach(() => {
    mockResolveEnvironmentDriverConfigForRuntime.mockReset();
  });

  it("carries the concurrent-sync opt-in on the snapshot and the runner", async () => {
    const { target } = await buildSandboxTarget({ snapshot: FULL_GRANT, supportsSync: true });
    expect(target.effectiveCapabilities?.concurrentSyncOperations).toBe(true);
    expect(target.runner?.allowConcurrentSyncOperations).toBe(true);
  });

  it("keeps the concurrent-sync opt-in off when the snapshot removes it", async () => {
    const { target } = await buildSandboxTarget({
      snapshot: { ...FULL_GRANT, concurrentSyncOperations: false },
      supportsSync: true,
    });
    expect(target.effectiveCapabilities?.concurrentSyncOperations).toBe(false);
    expect(target.runner?.allowConcurrentSyncOperations).toBe(false);
  });

  it("keeps the concurrent-sync opt-in off when the resolution rejects", async () => {
    // A rejected resolution carries no snapshot; it must not read as an open
    // grant. The runner keeps the opt-in off.
    const { target } = await buildSandboxTarget({
      snapshot: null,
      supportsSync: true,
      rejectResolution: true,
    });
    expect(target.effectiveCapabilities).toBeUndefined();
    expect(target.runner?.allowConcurrentSyncOperations).toBe(false);
  });
});

// Session-output streaming is decided downstream from the carried snapshot
// alone (see `streamAgentSessionOutput` in `acpx-engine/execute.ts`): the bridge
// streams only when the snapshot grants `incrementalSessionOutput`. That key is
// opt-in, so a generic one-shot provider that keeps persistent process sessions
// and runs independent control commands, yet never declares incremental session
// output, keeps the poll path. These tests prove the target carries the exact
// capability that drives that decision.
describe("effective snapshot carries the session-output-streaming capability", () => {
  beforeEach(() => {
    mockResolveEnvironmentDriverConfigForRuntime.mockReset();
  });

  it("carries incremental session output when the snapshot grants it (stream on)", async () => {
    const { target } = await buildSandboxTarget({ snapshot: FULL_GRANT, supportsSync: false });
    expect(target.effectiveCapabilities?.incrementalSessionOutput).toBe(true);
  });

  it("drops incremental session output when the snapshot removes it (poll)", async () => {
    const { target } = await buildSandboxTarget({
      snapshot: { ...FULL_GRANT, incrementalSessionOutput: false },
      supportsSync: false,
    });
    expect(target.effectiveCapabilities?.incrementalSessionOutput).toBe(false);
  });

  it("keeps the poll path for a generic one-shot provider with broad caps but no streaming opt-in", async () => {
    // The regression case: a generic one-shot provider (for example Modal)
    // exposes the two broad session capabilities but never emits incremental
    // session output. The streaming gate reads `incrementalSessionOutput`, so
    // this provider keeps the poll path.
    const { target } = await buildSandboxTarget({
      snapshot: {
        ...FULL_GRANT,
        persistentProcessSessions: true,
        independentControlCommands: true,
        incrementalSessionOutput: false,
      },
      supportsSync: false,
    });
    expect(target.effectiveCapabilities?.persistentProcessSessions).toBe(true);
    expect(target.effectiveCapabilities?.independentControlCommands).toBe(true);
    expect(target.effectiveCapabilities?.incrementalSessionOutput).toBe(false);
  });
});

describe("effective snapshot gates the persistent-session execution decision", () => {
  beforeEach(() => {
    mockResolveEnvironmentDriverConfigForRuntime.mockReset();
  });

  it("forces the persistent session when the snapshot grants persistent process sessions", async () => {
    const { target, execute } = await buildSandboxTarget({ snapshot: FULL_GRANT, supportsSync: false });
    await target.runner?.execute({ command: "node", args: ["agent.js"], useSession: true });
    const call = execute.mock.calls[0]![0] as { forceSession?: boolean };
    expect(call.forceSession).toBe(true);
  });

  it("never forces the persistent session when the snapshot removes persistent process sessions", async () => {
    // The bridge still asks for the session with `useSession`, but the provider
    // cannot keep one, so the seam runs the command one-shot instead.
    const { target, execute } = await buildSandboxTarget({
      snapshot: { ...FULL_GRANT, persistentProcessSessions: false },
      supportsSync: false,
    });
    await target.runner?.execute({ command: "node", args: ["agent.js"], useSession: true });
    const call = execute.mock.calls[0]![0] as { forceSession?: boolean };
    expect(call.forceSession).toBe(false);
  });
});

describe("a rejected capability resolution fails closed for persistent-session behavior", () => {
  beforeEach(() => {
    mockResolveEnvironmentDriverConfigForRuntime.mockReset();
  });

  it("omits the snapshot when the resolution rejects", async () => {
    // A rejected resolution carries no snapshot; the target never publishes a
    // guessed capability set.
    const { target } = await buildSandboxTarget({
      snapshot: null,
      supportsSync: false,
      rejectResolution: true,
    });
    expect(target.effectiveCapabilities).toBeUndefined();
  });

  it("carries no snapshot for session-output streaming when the resolution rejects", async () => {
    // A rejected resolution must not read as an open grant that enables
    // streaming. The target carries no snapshot, so the bridge keeps the host
    // output-file poll path.
    const { target } = await buildSandboxTarget({
      snapshot: null,
      supportsSync: false,
      rejectResolution: true,
    });
    expect(target.effectiveCapabilities).toBeUndefined();
  });

  it("never forces the persistent session when the resolution rejects", async () => {
    // The bridge asks for the session with `useSession`, but a rejected
    // resolution fails closed, so the seam runs the command one-shot instead.
    const { target, execute } = await buildSandboxTarget({
      snapshot: null,
      supportsSync: false,
      rejectResolution: true,
    });
    await target.runner?.execute({ command: "node", args: ["agent.js"], useSession: true });
    const call = execute.mock.calls[0]![0] as { forceSession?: boolean };
    expect(call.forceSession).toBe(false);
  });

  it("omits the native sync hooks when the resolution rejects", async () => {
    // The worker advertises both sync verbs, but a rejected resolution must not
    // read as an open grant. Fail closed and keep the base64 fallback, so an
    // unverified provider never gets the native sync path.
    const { target } = await buildSandboxTarget({
      snapshot: null,
      supportsSync: true,
      rejectResolution: true,
    });
    expect(target.runner?.syncIn).toBeUndefined();
    expect(target.runner?.syncOut).toBeUndefined();
  });
});
