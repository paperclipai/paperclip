import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveEnvironmentDriverConfigForRuntime } = vi.hoisted(() => ({
  mockResolveEnvironmentDriverConfigForRuntime: vi.fn(),
}));

vi.mock("../services/environment-config.js", () => ({
  resolveEnvironmentDriverConfigForRuntime: mockResolveEnvironmentDriverConfigForRuntime,
}));

import {
  measureStartupStep,
  runWithoutActiveStep,
  SANDBOX_STARTUP_SPAN_ATTRS,
} from "@paperclipai/adapter-utils/acpx-engine/startup-timing";
import {
  DEFAULT_SANDBOX_REMOTE_CWD,
  resolveEnvironmentExecutionTarget,
} from "../services/environment-execution-target.js";

const A = SANDBOX_STARTUP_SPAN_ATTRS;

// A recording trace context that models the OTel parenting contract:
// `startSpan(name, options, context)` reads the parent from the explicit
// `context` token that `contextWithSpan` built. A test asserts the exact parent
// of each child span without an OTel package.
function createRecordingTrace() {
  const spans: Array<{
    name: string;
    attributes: Record<string, unknown>;
    parent: unknown;
    ended: boolean;
    setAttribute(key: string, value: unknown): void;
    end(): void;
  }> = [];
  const tracer = {
    startSpan(name: string, _options?: unknown, context?: unknown) {
      const parent =
        context && typeof context === "object" && "span" in context
          ? (context as { span: unknown }).span
          : null;
      const span = {
        name,
        attributes: {} as Record<string, unknown>,
        parent,
        ended: false,
        setAttribute(key: string, value: unknown) {
          span.attributes[key] = value;
        },
        end() {
          span.ended = true;
        },
      };
      spans.push(span);
      return span;
    },
  };
  const contextWithSpan = (span: unknown) => ({ span });
  return { tracer, contextWithSpan, spans };
}

// A fake tracer that records the third `startSpan` argument — the parent-context
// token — for each span, keyed by the span name. `contextWithSpan` wraps a span
// in a token and keeps that token, so a test asserts the exact token identity,
// not a rebuilt copy. The exec seam reads the parent-context token from the
// active step store and passes it as the third `startSpan` argument. This helper
// holds the parent assertion in one place for reuse.
function recordParentContext() {
  const calls: Array<{ name: string; parentContext: unknown; span: unknown }> = [];
  const tokens = new Map<unknown, unknown>();
  const tracer = {
    startSpan(name: string, _options?: unknown, parentContext?: unknown) {
      const span = {
        name,
        setAttribute(_key: string, _value: unknown) {},
        setStatus(_status: { code: number; message?: string }) {},
        end() {},
      };
      calls.push({ name, parentContext, span });
      return span;
    },
  };
  const contextWithSpan = (span: unknown) => {
    const token = { span };
    tokens.set(span, token);
    return token;
  };
  // The span object recorded for a given span name.
  const spanNamed = (name: string) => calls.find((call) => call.name === name)?.span;
  // The parent-context token that `startSpan` received for a given span name.
  const parentContextFor = (name: string) =>
    calls.find((call) => call.name === name)?.parentContext;
  // The parent-context token that `contextWithSpan` returned for a given span.
  const tokenForSpan = (span: unknown) => tokens.get(span);
  return { tracer, contextWithSpan, calls, spanNamed, parentContextFor, tokenForSpan };
}

describe("resolveEnvironmentExecutionTarget", () => {
  beforeEach(() => {
    mockResolveEnvironmentDriverConfigForRuntime.mockReset();
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_RUNTIME_API_URL;
  });

  it("uses a bounded default cwd for sandbox targets when lease metadata omits remoteCwd", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: {
        id: "env-1",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
        },
      },
      leaseId: "lease-1",
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd: DEFAULT_SANDBOX_REMOTE_CWD,
      leaseId: "lease-1",
      environmentId: "env-1",
      timeoutMs: 30_000,
    });
  });

  it("keeps sandbox targets on bridge mode even when lease metadata includes a Paperclip API URL", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: {
        id: "env-1",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
        },
      },
      leaseId: "lease-1",
      leaseMetadata: {
        paperclipApiUrl: "https://paperclip.example.test",
      },
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd: DEFAULT_SANDBOX_REMOTE_CWD,
    });
    expect(target).not.toHaveProperty("paperclipApiUrl");
    expect(target).not.toHaveProperty("paperclipTransport");
  });

  it("passes through a provider-declared sandbox shell command from lease metadata", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "claude_local",
      environment: {
        id: "env-1",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
        },
      },
      leaseId: "lease-1",
      leaseMetadata: {
        shellCommand: "bash",
      },
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      shellCommand: "bash",
    });
  });

  it("keeps sandbox targets on callback bridge execution even when lease metadata advertises SSH access", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "claude_local",
      environment: {
        id: "env-1",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
        },
      },
      leaseId: "lease-1",
      leaseMetadata: {
        remoteCwd: "/home/sandbox/paperclip-workspace",
        sshAccess: {
          type: "ssh",
          host: "ssh.example.test",
          port: 22,
          username: "paperclip",
        },
      },
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd: "/home/sandbox/paperclip-workspace",
    });
  });

  it("resolves sandbox targets for every remote-managed adapter, including grok_local", async () => {
    for (const adapterType of [
      "claude_local",
      "codex_local",
      "cursor",
      "gemini_local",
      "grok_local",
      "opencode_local",
      "pi_local",
    ]) {
      mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
          reuseLease: false,
          timeoutMs: 30_000,
        },
      });

      const target = await resolveEnvironmentExecutionTarget({
        db: {} as never,
        companyId: "company-1",
        adapterType,
        environment: {
          id: "env-1",
          driver: "sandbox",
          config: { provider: "fake-plugin" },
        },
        leaseId: "lease-1",
        leaseMetadata: {},
        lease: null,
        environmentRuntime: null,
      });

      expect(target, `adapter ${adapterType}`).toMatchObject({
        kind: "remote",
        transport: "sandbox",
        providerKey: "fake-plugin",
      });
    }
  });

  it("returns null for adapters without remote-managed environment support", async () => {
    for (const driver of ["sandbox", "ssh"] as const) {
      const target = await resolveEnvironmentExecutionTarget({
        db: {} as never,
        companyId: "company-1",
        adapterType: "process",
        environment: {
          id: "env-1",
          driver,
          config: { provider: "fake-plugin" },
        },
        leaseId: "lease-1",
        leaseMetadata: {},
        lease: null,
        environmentRuntime: null,
      });

      expect(target, `driver ${driver}`).toBeNull();
    }
    expect(mockResolveEnvironmentDriverConfigForRuntime).not.toHaveBeenCalled();
  });

  it("resolves SSH execution targets for grok_local", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "ssh",
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "paperclip",
        remoteWorkspacePath: "/srv/paperclip",
        privateKey: "PRIVATE KEY",
        knownHosts: "[ssh.example.test]:22 ssh-ed25519 AAAA",
        strictHostKeyChecking: true,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "grok_local",
      environment: {
        id: "env-ssh-1",
        driver: "ssh",
        config: {},
      },
      leaseId: "lease-ssh-1",
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "ssh",
      remoteCwd: "/srv/paperclip",
    });
  });

  it("resolves SSH execution targets in bridge mode", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "ssh",
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "paperclip",
        remoteWorkspacePath: "/srv/paperclip",
        privateKey: "PRIVATE KEY",
        knownHosts: "[ssh.example.test]:22 ssh-ed25519 AAAA",
        strictHostKeyChecking: true,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: {
        id: "env-ssh-1",
        driver: "ssh",
        config: {},
      },
      leaseId: "lease-ssh-1",
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "ssh",
      remoteCwd: "/srv/paperclip",
      leaseId: "lease-ssh-1",
      environmentId: "env-ssh-1",
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "paperclip",
        remoteWorkspacePath: "/srv/paperclip",
        remoteCwd: "/srv/paperclip",
      },
    });
    expect(target).not.toHaveProperty("paperclipApiUrl");
  });

  it("exposes a sandbox runner with single-stream stdin upload disabled", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const environmentRuntime = {
      execute: vi.fn().mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok",
        stderr: "",
        metadata: { durationMs: 600, getDurationMs: 15 },
      }),
      supportsSync: vi.fn().mockReturnValue(false),
    };

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: { id: "env-1", driver: "sandbox", config: { provider: "fake-plugin" } },
      leaseId: "lease-1",
      leaseMetadata: { remoteCwd: "/workspace" },
      lease: { id: "lease-1" } as never,
      environmentRuntime: environmentRuntime as never,
    });

    const runner = (target as { runner?: {
      supportsSingleStreamStdinProgress?: boolean;
      execute(input: { command: string; args?: string[] }): Promise<unknown>;
    } }).runner;
    expect(runner).toBeTruthy();
    // Provider-backed sandbox RPCs do not surface bounded mid-stream progress
    // for a single stdin upload, so the runner leaves the capability disabled.
    expect(runner!.supportsSingleStreamStdinProgress).toBe(false);

    // The exec seam still runs each command; the run-log no longer carries the
    // detailed per-step round-trip or provider-duration counts.
    await runner!.execute({ command: "echo", args: ["a"] });
    await runner!.execute({ command: "echo", args: ["b"] });
    expect(environmentRuntime.execute).toHaveBeenCalledTimes(2);
  });

  it("forwards the session flags to the environment runtime execute", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const environmentRuntime = {
      execute: vi.fn().mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok",
        stderr: "",
        metadata: { durationMs: 600, getDurationMs: 15 },
      }),
      supportsSync: vi.fn().mockReturnValue(false),
    };

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: { id: "env-1", driver: "sandbox", config: { provider: "fake-plugin" } },
      leaseId: "lease-1",
      leaseMetadata: { remoteCwd: "/workspace" },
      lease: { id: "lease-1" } as never,
      environmentRuntime: environmentRuntime as never,
    });

    const runner = (target as { runner?: {
      execute(input: {
        command: string;
        args?: string[];
        useSession?: boolean;
        bypassSession?: boolean;
      }): Promise<unknown>;
    } }).runner!;

    // The agent command opts onto the persistent session with `useSession`,
    // which the seam maps to `forceSession`. It never bypasses the session.
    await runner.execute({ command: "node", args: ["script.js"], useSession: true });
    // A bridge control-plane exec opts off the persistent session with
    // `bypassSession`, which the seam forwards unchanged.
    await runner.execute({ command: "sh", args: ["-c", "cat"], bypassSession: true });

    const first = environmentRuntime.execute.mock.calls[0]![0] as {
      forceSession?: boolean;
      bypassSession?: boolean;
    };
    expect(first.forceSession).toBe(true);
    expect(first.bypassSession).toBeUndefined();

    const second = environmentRuntime.execute.mock.calls[1]![0] as {
      forceSession?: boolean;
      bypassSession?: boolean;
    };
    expect(second.forceSession).toBeUndefined();
    expect(second.bypassSession).toBe(true);
  });

  // A recording tracer that captures each provider-exec span's name, attribute
  // map, and end. It satisfies the structural tracer the seam calls.
  function createRecordingExecTracer() {
    const spans: Array<{
      name: string;
      attributes: Record<string, unknown>;
      status: { code: number; message?: string } | null;
      ended: boolean;
    }> = [];
    const tracer = {
      startSpan(name: string) {
        const span = {
          name,
          attributes: {} as Record<string, unknown>,
          status: null as { code: number; message?: string } | null,
          ended: false,
          setAttribute(key: string, value: unknown) {
            span.attributes[key] = value;
          },
          setStatus(status: { code: number; message?: string }) {
            span.status = status;
          },
          end() {
            span.ended = true;
          },
        };
        spans.push(span);
        return span;
      },
    };
    return { tracer, spans };
  }

  // The value of `SpanStatusCode.ERROR` in `@opentelemetry/api`. A failed exec
  // span must carry this native status, not only the `failed` outcome attribute.
  const SPAN_STATUS_CODE_ERROR = 2;

  // The closed span-attribute allowlist for a `sandbox.exec` span. A test
  // asserts every recorded key is in this set, so a command, an argument, a
  // path, an id, or an error-text key can never ride the span.
  const ALLOWED_EXEC_SPAN_ATTRIBUTE_KEYS = new Set<string>([
    A.provider,
    A.execCommand,
    A.execExitCode,
    A.execWallMs,
    A.execWaitBeforeMs,
    A.execSandboxMs,
    A.execNetworkMs,
    A.execCriticalPath,
    A.execCacheHit,
    A.outcome,
  ]);

  async function runnerFor(input: {
    provider: string;
    execResult: Record<string, unknown>;
    tracer: unknown;
  }) {
    return runnerWithExecute({
      provider: input.provider,
      tracer: input.tracer,
      execute: vi.fn().mockResolvedValue(input.execResult),
    });
  }

  // Build the sandbox runner with a custom provider-exec implementation, so a
  // test can drive a thrown execution or assert the span order around the await.
  async function runnerWithExecute(input: {
    provider: string;
    tracer: unknown;
    execute: (...args: unknown[]) => Promise<unknown>;
  }) {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: { provider: input.provider, reuseLease: false, timeoutMs: 30_000 },
    });
    const environmentRuntime = {
      execute: input.execute,
      supportsSync: vi.fn().mockReturnValue(false),
    };
    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: { id: "env-1", driver: "sandbox", config: { provider: input.provider } },
      leaseId: "lease-1",
      leaseMetadata: { remoteCwd: "/workspace" },
      lease: { id: "lease-1" } as never,
      environmentRuntime: environmentRuntime as never,
      tracer: input.tracer as never,
    });
    return (target as { runner?: {
      execute(input: { command: string; args?: string[] }): Promise<unknown>;
    } }).runner!;
  }

  // Run the sandbox runner's execute with an incremental log sink and collect
  // the ordered deliveries. The runner's execute accepts an `onLog`, so this
  // casts past the narrowed helper return type.
  async function runExecuteCollectingLogs(
    runner: { execute(input: unknown): Promise<unknown> },
  ): Promise<Array<[string, string]>> {
    const delivered: Array<[string, string]> = [];
    await runner.execute({
      command: "echo",
      onLog: async (stream: "stdout" | "stderr", chunk: string) => {
        delivered.push([stream, chunk]);
      },
    });
    return delivered;
  }

  it("delivers only the un-streamed suffix after a provider streams a prefix then polls the complete result", async () => {
    // The provider streams a prefix through the incremental sink, then its
    // stream fails and it polls the complete output as the final result. The
    // reconciler must deliver the remaining tail once, so no output byte is lost
    // or repeated.
    const { tracer } = createRecordingExecTracer();
    const runner = await runnerWithExecute({
      provider: "daytona",
      tracer,
      execute: async (input: unknown) => {
        const typed = input as { onLog?: (s: "stdout" | "stderr", c: string) => Promise<void> };
        await typed.onLog?.("stdout", "hello ");
        await typed.onLog?.("stderr", "warn:");
        return { exitCode: 0, signal: null, timedOut: false, stdout: "hello world", stderr: "warn:done" };
      },
    });
    const delivered = await runExecuteCollectingLogs(
      runner as { execute(input: unknown): Promise<unknown> },
    );
    expect(delivered).toEqual([
      ["stdout", "hello "],
      ["stderr", "warn:"],
      ["stdout", "world"],
      ["stderr", "done"],
    ]);
  });

  it("does not repeat output when the provider already streamed the complete result", async () => {
    // The provider streams the whole output through the incremental sink and
    // returns the same complete result. The suffix is empty, so the reconciler
    // never re-delivers the streamed bytes.
    const { tracer } = createRecordingExecTracer();
    const runner = await runnerWithExecute({
      provider: "daytona",
      tracer,
      execute: async (input: unknown) => {
        const typed = input as { onLog?: (s: "stdout" | "stderr", c: string) => Promise<void> };
        await typed.onLog?.("stdout", "full");
        return { exitCode: 0, signal: null, timedOut: false, stdout: "full", stderr: "" };
      },
    });
    const delivered = await runExecuteCollectingLogs(
      runner as { execute(input: unknown): Promise<unknown> },
    );
    expect(delivered).toEqual([["stdout", "full"]]);
  });

  it("delivers the full captured output when the provider streams nothing incrementally", async () => {
    // The provider streams no incremental chunk, so the whole final result is
    // the suffix and reaches the sink once.
    const { tracer } = createRecordingExecTracer();
    const runner = await runnerWithExecute({
      provider: "daytona",
      tracer,
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "batch-out",
        stderr: "batch-err",
      }),
    });
    const delivered = await runExecuteCollectingLogs(
      runner as { execute(input: unknown): Promise<unknown> },
    );
    expect(delivered).toEqual([
      ["stdout", "batch-out"],
      ["stderr", "batch-err"],
    ]);
  });

  it("delivers the whole final output when the poll fallback buffer does not continue the streamed prefix", async () => {
    // The provider streams a prefix, then its stream fails and it polls a
    // buffer that does NOT start with that prefix. A length slice would drop
    // the leading bytes of the poll buffer and corrupt the durable log, so the
    // reconciler delivers the whole final output instead. The streamed prefix
    // repeats, but no output byte is lost or truncated.
    const { tracer } = createRecordingExecTracer();
    const runner = await runnerWithExecute({
      provider: "daytona",
      tracer,
      execute: async (input: unknown) => {
        const typed = input as { onLog?: (s: "stdout" | "stderr", c: string) => Promise<void> };
        await typed.onLog?.("stdout", "hello ");
        await typed.onLog?.("stderr", "warn:");
        // The poll buffer starts with different leading text on both streams.
        return { exitCode: 0, signal: null, timedOut: false, stdout: "RESYNCED output", stderr: "RESET err" };
      },
    });
    const delivered = await runExecuteCollectingLogs(
      runner as { execute(input: unknown): Promise<unknown> },
    );
    expect(delivered).toEqual([
      ["stdout", "hello "],
      ["stderr", "warn:"],
      ["stdout", "RESYNCED output"],
      ["stderr", "RESET err"],
    ]);
  });

  it("sets the provider duration attributes from finite Daytona-shaped metadata", async () => {
    const { tracer, spans } = createRecordingExecTracer();
    const runner = await runnerFor({
      provider: "daytona",
      execResult: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok",
        stderr: "",
        metadata: { durationMs: 600, getDurationMs: 15 },
      },
      tracer,
    });

    await runner.execute({ command: "echo", args: ["a"] });

    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe("sandbox.exec");
    expect(span.ended).toBe(true);
    // `sandbox_ms` = provider in-sandbox run; `wait_before_ms` = handle-fetch.
    expect(span.attributes[A.execSandboxMs]).toBe(600);
    expect(span.attributes[A.execWaitBeforeMs]).toBe(15);
    expect(span.attributes[A.provider]).toBe("daytona");
    // `echo` is a known command basename, so it rides as a clamped label.
    expect(span.attributes[A.execCommand]).toBe("echo");
    expect(span.attributes[A.execExitCode]).toBe(0);
    expect(span.attributes[A.outcome]).toBe("ok");
    // A successful exec leaves the native span status unset (default OTel status).
    expect(span.status).toBeNull();
    expect(span.attributes[A.execCriticalPath]).toBe(true);
    // The wall time is a real, finite, non-negative number.
    expect(typeof span.attributes[A.execWallMs]).toBe("number");
    expect(span.attributes[A.execWallMs] as number).toBeGreaterThanOrEqual(0);
  });

  it("carries the explicit exec cache_hit from result.metadata.cacheHit", async () => {
    const { tracer, spans } = createRecordingExecTracer();
    const runner = await runnerFor({
      provider: "daytona",
      execResult: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok",
        stderr: "",
        metadata: { durationMs: 600, getDurationMs: 0, cacheHit: true },
      },
      tracer,
    });

    await runner.execute({ command: "echo", args: ["a"] });

    const span = spans[0]!;
    // The flag comes from the metadata boolean, not from a zero handle-fetch.
    expect(span.attributes[A.execCacheHit]).toBe(true);
  });

  it("omits exec cache_hit when the provider reports no cacheHit metadata", async () => {
    const { tracer, spans } = createRecordingExecTracer();
    const runner = await runnerFor({
      provider: "daytona",
      execResult: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok",
        stderr: "",
        metadata: { durationMs: 600, getDurationMs: 15 },
      },
      tracer,
    });

    await runner.execute({ command: "echo", args: ["a"] });

    const span = spans[0]!;
    // A provider that omits the boolean yields no attribute — never `false`.
    expect(span.attributes).not.toHaveProperty(A.execCacheHit);
  });

  it("omits each duration attribute when a provider returns no timing (does not throw, keeps provider)", async () => {
    const { tracer, spans } = createRecordingExecTracer();
    const runner = await runnerFor({
      provider: "kubernetes",
      execResult: { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" },
      tracer,
    });

    await expect(runner.execute({ command: "echo" })).resolves.toBeTruthy();

    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(A.execSandboxMs in span.attributes).toBe(false);
    expect(A.execWaitBeforeMs in span.attributes).toBe(false);
    // With no provider durations, the derived network time is also omitted.
    expect(A.execNetworkMs in span.attributes).toBe(false);
    // The provider attribute is always present so a trace shows which provider ran.
    expect(span.attributes[A.provider]).toBe("kubernetes");
  });

  it("never emits a `0` duration attribute for a Daytona timeout that omits durationMs", async () => {
    const { tracer, spans } = createRecordingExecTracer();
    const runner = await runnerFor({
      provider: "daytona",
      execResult: {
        exitCode: 124,
        signal: null,
        timedOut: true,
        stdout: "",
        stderr: "",
        // The Daytona timeout branch may leave durationMs undefined.
        metadata: { getDurationMs: 20 },
      },
      tracer,
    });

    await runner.execute({ command: "sleep", args: ["999"] });

    const span = spans[0]!;
    expect(A.execSandboxMs in span.attributes).toBe(false);
    expect(span.attributes[A.execWaitBeforeMs]).toBe(20);
    // A non-zero exit yields `failed`; the exit code rides as a number.
    expect(span.attributes[A.outcome]).toBe("failed");
    // A failed exec also sets the native span status to ERROR.
    expect(span.status).toEqual({ code: SPAN_STATUS_CODE_ERROR });
    expect(span.attributes[A.execExitCode]).toBe(124);
    // `sleep` is not in the known-command allowlist, so it clamps to `other`.
    expect(span.attributes[A.execCommand]).toBe("other");
  });

  it("never sets a command, arg, env, cwd, or stream text as a span attribute, even with secret-like input", async () => {
    const { tracer, spans } = createRecordingExecTracer();
    const runner = await runnerFor({
      provider: "daytona",
      execResult: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        // Secret-like standard-stream text must never ride the span.
        stdout: "AKIAIOSFODNN7EXAMPLE token=s3cr3t-stdout",
        stderr: "error at /home/agent/.ssh/id_rsa: s3cr3t-stderr",
        metadata: { durationMs: 5, getDurationMs: 1 },
      },
      tracer,
    });

    await runner.execute({
      // A full command line, a secret-like argument, a secret-like env value, a
      // stdin blob, and a path-like cwd — none may ride the span.
      command: "bash -lc 'rm -rf /secret/path'",
      args: ["--token", "s3cr3t-arg", "--password", "hunter2"],
      env: { AWS_SECRET_ACCESS_KEY: "s3cr3t-env", HOME: "/home/agent" },
      cwd: "/home/agent/secret-workspace/.git",
      stdin: "s3cr3t-stdin-blob",
    });

    const span = spans[0]!;
    for (const key of Object.keys(span.attributes)) {
      expect(ALLOWED_EXEC_SPAN_ATTRIBUTE_KEYS.has(key), `non-allowlisted key "${key}"`).toBe(true);
    }
    // The command clamps to the bounded `other` fallback (not a known basename).
    expect(span.attributes[A.execCommand]).toBe("other");
    // No forbidden substring rides any attribute value.
    const values = Object.values(span.attributes).map(String);
    for (const forbidden of [
      "rm -rf",
      "s3cr3t",
      "hunter2",
      "AKIA",
      "id_rsa",
      "/secret/path",
      "/home/agent",
      "secret-workspace",
      "stdin",
    ]) {
      expect(
        values.some((value) => value.includes(forbidden)),
        `attribute value leaked "${forbidden}"`,
      ).toBe(false);
    }
  });

  it("normalizes a plugin-backed provider key to `plugin` and keeps a built-in family as-is", async () => {
    const plugin = createRecordingExecTracer();
    const pluginRunner = await runnerFor({
      provider: "acme-custom-sandbox",
      execResult: { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" },
      tracer: plugin.tracer,
    });
    await pluginRunner.execute({ command: "echo" });
    expect(plugin.spans[0]!.attributes[A.provider]).toBe("plugin");

    const builtIn = createRecordingExecTracer();
    const builtInRunner = await runnerFor({
      provider: "e2b",
      execResult: { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" },
      tracer: builtIn.tracer,
    });
    await builtInRunner.execute({ command: "echo" });
    expect(builtIn.spans[0]!.attributes[A.provider]).toBe("e2b");
  });

  it("parents the exec span to the active step span when the exec runs inside a measured step", async () => {
    const { tracer, contextWithSpan, spans } = createRecordingTrace();
    const runner = await runnerFor({
      provider: "daytona",
      execResult: { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" },
      tracer,
    });

    // The exec seam reads the active step context through `getActiveStepContext`.
    // Wrap the exec in one measured step and assert the exec span parents to the
    // step span, not to nothing.
    await measureStartupStep({}, () => 0, "stage.sync", () => runner.execute({ command: "echo" }), {
      tracer,
      contextWithSpan,
    });

    const stepSpan = spans.find((span) => span.name === "stage.sync");
    const execSpan = spans.find((span) => span.name === "sandbox.exec");
    expect(stepSpan).toBeTruthy();
    expect(execSpan).toBeTruthy();
    expect(execSpan!.parent).toBe(stepSpan);
  });

  it("opens an unparented exec span when the exec runs outside any measured step", async () => {
    const { tracer, spans } = createRecordingTrace();
    const runner = await runnerFor({
      provider: "daytona",
      execResult: { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" },
      tracer,
    });

    // No measured step wraps the exec, so the active step context is null and
    // the exec span opens unparented (a no-op when tracing is off).
    await runner.execute({ command: "echo" });

    const execSpan = spans.find((span) => span.name === "sandbox.exec");
    expect(execSpan).toBeTruthy();
    expect(execSpan!.parent).toBeNull();
  });

  // The three baseline tests below record the third `startSpan` argument — the
  // parent-context token — and assert its identity. They pin the current exec
  // parenting so a later phase that re-points the exec parent has a fixed
  // reference point.
  it("test_exec_inside_measured_step_parents_to_step_context", async () => {
    const rec = recordParentContext();
    const runner = await runnerFor({
      provider: "daytona",
      execResult: { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" },
      tracer: rec.tracer,
    });

    // Run the seam `execute` inside one measured step. The step publishes its
    // child context to the active step store, so the seam reads it and passes it
    // as the third `startSpan` argument for the exec span.
    await measureStartupStep({}, () => 0, "stage.sync", () => runner.execute({ command: "echo" }), {
      tracer: rec.tracer,
      contextWithSpan: rec.contextWithSpan,
    });

    const stepSpan = rec.spanNamed("stage.sync");
    expect(stepSpan).toBeTruthy();
    // The exec span parents to the step span. The third `startSpan` argument is
    // the exact parent-context token that `contextWithSpan` built for the step
    // span, not a rebuilt copy.
    expect(rec.parentContextFor("sandbox.exec")).toBe(rec.tokenForSpan(stepSpan));
  });

  it("test_exec_in_root_region_is_unparented_today", async () => {
    const rec = recordParentContext();
    const runner = await runnerFor({
      provider: "daytona",
      execResult: { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" },
      tracer: rec.tracer,
    });

    // No measured step wraps the exec, so the active step store is empty. The
    // seam reads no parent and passes `undefined` as the third `startSpan`
    // argument. The exec span opens unparented today.
    await runner.execute({ command: "echo" });

    expect(rec.spanNamed("sandbox.exec")).toBeTruthy();
    expect(rec.parentContextFor("sandbox.exec")).toBeUndefined();
  });

  it("test_exec_on_runWithoutActiveStep_is_unparented_today", async () => {
    const rec = recordParentContext();
    const runner = await runnerFor({
      provider: "daytona",
      execResult: { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" },
      tracer: rec.tracer,
    });

    // `runWithoutActiveStep` empties the active step store for the wrapped work.
    // The seam reads no parent and passes `undefined` as the third `startSpan`
    // argument. The exec span opens unparented today.
    await runWithoutActiveStep(() => runner.execute({ command: "echo" }));

    expect(rec.spanNamed("sandbox.exec")).toBeTruthy();
    expect(rec.parentContextFor("sandbox.exec")).toBeUndefined();
  });

  it("opens the exec span before the provider await so the span wraps the execution", async () => {
    const { tracer, spans } = createRecordingExecTracer();
    // Assert the span is already open (started, not ended) while the provider
    // runs. If the seam opened the span after the await, no open span would
    // exist here and the native span duration would be near zero.
    const runner = await runnerWithExecute({
      provider: "daytona",
      tracer,
      execute: vi.fn().mockImplementation(async () => {
        const open = spans.find((span) => span.name === "sandbox.exec");
        expect(open, "the exec span must be open during the provider await").toBeTruthy();
        expect(open!.ended).toBe(false);
        return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
      }),
    });

    await runner.execute({ command: "echo" });

    const span = spans.find((s) => s.name === "sandbox.exec");
    expect(span!.ended).toBe(true);
    expect(span!.attributes[A.outcome]).toBe("ok");
  });

  it("records a failed exec span and rethrows when the provider execution throws", async () => {
    const { tracer, spans } = createRecordingExecTracer();
    const runner = await runnerWithExecute({
      provider: "daytona",
      tracer,
      execute: vi.fn().mockRejectedValue(new Error("provider transport failed")),
    });

    // The original error rides through unchanged; observability never swallows it.
    await expect(runner.execute({ command: "echo" })).rejects.toThrow("provider transport failed");

    // A thrown execution still produces one ended span with the `failed` outcome,
    // instead of no span at all.
    const span = spans.find((s) => s.name === "sandbox.exec");
    expect(span).toBeTruthy();
    expect(span!.ended).toBe(true);
    expect(span!.attributes[A.outcome]).toBe("failed");
    // A thrown execution also sets the native span status to ERROR.
    expect(span!.status).toEqual({ code: SPAN_STATUS_CODE_ERROR });
    expect(span!.attributes[A.provider]).toBe("daytona");
    // `echo` is a known basename, so the clamped command rides the span.
    expect(span!.attributes[A.execCommand]).toBe("echo");
    // No exec result exists, so the exit code never rides the span.
    expect(A.execExitCode in span!.attributes).toBe(false);
    // The wall time is a real, finite, non-negative number.
    expect(typeof span!.attributes[A.execWallMs]).toBe("number");
    expect(span!.attributes[A.execWallMs] as number).toBeGreaterThanOrEqual(0);
    // Only allowlisted keys ride the failed span.
    for (const key of Object.keys(span!.attributes)) {
      expect(ALLOWED_EXEC_SPAN_ATTRIBUTE_KEYS.has(key), `non-allowlisted key "${key}"`).toBe(true);
    }
  });

  it("keeps the exec span outcome `ok` when the execution succeeds but a log callback rejects", async () => {
    const { tracer, spans } = createRecordingExecTracer();
    // The provider execution succeeds and returns stdout, so the seam invokes
    // the log callback. The callback rejects, which models a downstream log-sink
    // failure. The rejection must reach the caller, but it must never reclassify
    // the successful execution as a failed span.
    const runner = await runnerWithExecute({
      provider: "daytona",
      tracer,
      execute: vi.fn().mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "hello",
        stderr: "",
      }),
    });

    const onLog = vi.fn().mockRejectedValue(new Error("log sink rejected"));
    // The rejection rides through unchanged; observability never swallows it.
    await expect(
      (runner as { execute(input: unknown): Promise<unknown> }).execute({ command: "echo", onLog }),
    ).rejects.toThrow("log sink rejected");

    // The span ended with the successful outcome from the command result, not
    // the failed outcome. A log failure never marks the execution failed.
    const span = spans.find((s) => s.name === "sandbox.exec");
    expect(span).toBeTruthy();
    expect(span!.ended).toBe(true);
    expect(span!.attributes[A.outcome]).toBe("ok");
    // A log-callback rejection never marks the span as ERROR; the status stays unset.
    expect(span!.status).toBeNull();
    expect(span!.attributes[A.execExitCode]).toBe(0);
    // The seam reached the log callback exactly once (the stdout delivery).
    expect(onLog).toHaveBeenCalledTimes(1);
  });

  it("delivers incremental logs before the final result and does not duplicate them", async () => {
    const { tracer } = createRecordingExecTracer();
    const runner = await runnerWithExecute({
      provider: "daytona",
      tracer,
      execute: vi.fn(async (input: { onLog?: (s: string, c: string) => Promise<void> }) => {
        // The provider streams the output while the command runs.
        await input.onLog?.("stdout", "chunk-1");
        await input.onLog?.("stderr", "chunk-2");
        await input.onLog?.("stdout", "chunk-3");
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "chunk-1chunk-3",
          stderr: "chunk-2",
        };
      }),
    });

    const onLog = vi.fn();
    const result = await (runner as {
      execute(input: unknown): Promise<{ stdout: string; stderr: string; exitCode: number }>;
    }).execute({ command: "echo", onLog });

    // The runner receives the incremental chunks in order, and NOT a repeated
    // delivery of the final stdout/stderr.
    expect(onLog.mock.calls).toEqual([
      ["stdout", "chunk-1"],
      ["stderr", "chunk-2"],
      ["stdout", "chunk-3"],
    ]);
    // The final result stays available to the caller for parsing and fallback.
    expect(result).toMatchObject({ exitCode: 0, stdout: "chunk-1chunk-3", stderr: "chunk-2" });
  });

  it("still delivers the final result to the runner when the provider does not stream", async () => {
    const { tracer } = createRecordingExecTracer();
    const runner = await runnerWithExecute({
      provider: "daytona",
      tracer,
      // A provider that never calls onLog returns only the final result.
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "final-out",
        stderr: "final-err",
      })),
    });

    const onLog = vi.fn();
    const result = await (runner as {
      execute(input: unknown): Promise<{ stdout: string; stderr: string }>;
    }).execute({ command: "echo", onLog });

    expect(onLog.mock.calls).toEqual([
      ["stdout", "final-out"],
      ["stderr", "final-err"],
    ]);
    expect(result).toMatchObject({ stdout: "final-out", stderr: "final-err" });
  });

  it("creates exactly one sandbox.exec span for one streamed provider call", async () => {
    const { tracer, spans } = createRecordingExecTracer();
    const runner = await runnerWithExecute({
      provider: "daytona",
      tracer,
      execute: vi.fn(async (input: { onLog?: (s: string, c: string) => Promise<void> }) => {
        await input.onLog?.("stdout", "chunk-a");
        await input.onLog?.("stdout", "chunk-b");
        await input.onLog?.("stderr", "chunk-c");
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "chunk-achunk-b",
          stderr: "chunk-c",
        };
      }),
    });

    const onLog = vi.fn();
    await (runner as { execute(input: unknown): Promise<unknown> }).execute({
      command: "echo",
      onLog,
    });

    // One long-lived provider call opens one span; each stream chunk opens none.
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("sandbox.exec");
    expect(spans[0]!.ended).toBe(true);
  });

  it("keeps streamed log text and secret values out of span attributes", async () => {
    const { tracer, spans } = createRecordingExecTracer();
    const secret = "sk-super-secret-value";
    const runner = await runnerWithExecute({
      provider: "daytona",
      tracer,
      execute: vi.fn(async (input: { onLog?: (s: string, c: string) => Promise<void> }) => {
        await input.onLog?.("stdout", `token=${secret}\n`);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: `token=${secret}\n`,
          stderr: "",
        };
      }),
    });

    const onLog = vi.fn();
    // The secret rides the env and the streamed chunk, never the command label.
    await (runner as { execute(input: unknown): Promise<unknown> }).execute({
      command: "run-agent",
      env: { API_KEY: secret },
      onLog,
    });

    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    // Attributes carry only the closed allowlist — never log text or secrets.
    for (const key of Object.keys(span.attributes)) {
      expect(ALLOWED_EXEC_SPAN_ATTRIBUTE_KEYS.has(key), `non-allowlisted key "${key}"`).toBe(true);
    }
    const serialized = JSON.stringify(span.attributes);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("token=");
    expect(serialized).not.toContain("chunk");
  });

  // Fire one run-time exec from a bridge continuation that runs after the step
  // span ended. Each bridge step (`bridge.paperclip`, `bridge.process-session`)
  // starts long-lived work with `criticalPath: false`. The bridge boundary wraps
  // that long-lived work in `runWithoutActiveStep`, exactly as modeled here, so
  // the continuation reads an empty active step. Return the recorded exec span.
  async function runContinuationExec(step: string, options: { wrap: boolean }) {
    const { tracer, contextWithSpan, spans } = createRecordingTrace();
    const runner = await runnerFor({
      provider: "daytona",
      execResult: { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" },
      tracer,
    });

    let resolveExec!: () => void;
    const execDone = new Promise<void>((resolve) => {
      resolveExec = resolve;
    });

    // Schedule the exec from a timer inside the step body, so it fires after the
    // step span ends. The `wrap` flag models the fix: when true, the boundary
    // wraps the long-lived work in `runWithoutActiveStep`; when false, it models
    // the pre-fix leak.
    const scheduleContinuation = () => {
      setTimeout(() => {
        void runner.execute({ command: "echo" }).then(() => resolveExec());
      }, 0);
    };

    await measureStartupStep(
      {},
      () => 0,
      step,
      async () => {
        if (options.wrap) {
          runWithoutActiveStep(scheduleContinuation);
        } else {
          scheduleContinuation();
        }
        return "started";
      },
      { tracer, contextWithSpan, criticalPath: false },
    );

    await execDone;
    return spans.find((span) => span.name === "sandbox.exec");
  }

  it("opens an unparented exec span for a process-session bridge continuation", async () => {
    const execSpan = await runContinuationExec("bridge.process-session", { wrap: true });
    expect(execSpan).toBeTruthy();
    // The step span ended and the boundary emptied the store, so the continuation
    // exec opens a root span, not one under the dead bridge step.
    expect(execSpan!.parent).toBeNull();
  });

  it("opens an unparented exec span for a paperclip bridge continuation", async () => {
    const execSpan = await runContinuationExec("bridge.paperclip", { wrap: true });
    expect(execSpan).toBeTruthy();
    expect(execSpan!.parent).toBeNull();
  });

  it("does not copy the stale criticalPath = false flag onto a continuation exec", async () => {
    const execSpan = await runContinuationExec("bridge.process-session", { wrap: true });
    expect(execSpan).toBeTruthy();
    // The bridge step set `criticalPath: false`. The continuation reads an empty
    // store, so the exec span records the default `true`, never the stale `false`.
    expect(execSpan!.attributes[A.execCriticalPath]).toBe(true);
    expect(execSpan!.attributes[A.execCriticalPath]).not.toBe(false);
  });

  it("leaks the ended step onto a continuation exec without the boundary wrap", async () => {
    // The mechanism guard: an unwrapped continuation keeps the ended bridge step
    // store, so the exec span parents to the dead step and copies its
    // `criticalPath: false`. The boundary wrap in the two tests above removes both
    // defects, so this suite fails if a future edit drops the wrap.
    const { tracer, contextWithSpan, spans } = createRecordingTrace();
    const runner = await runnerFor({
      provider: "daytona",
      execResult: { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" },
      tracer,
    });

    let resolveExec!: () => void;
    const execDone = new Promise<void>((resolve) => {
      resolveExec = resolve;
    });

    await measureStartupStep(
      {},
      () => 0,
      "bridge.process-session",
      async () => {
        setTimeout(() => {
          void runner.execute({ command: "echo" }).then(() => resolveExec());
        }, 0);
        return "started";
      },
      { tracer, contextWithSpan, criticalPath: false },
    );

    await execDone;

    const stepSpan = spans.find((span) => span.name === "bridge.process-session");
    const execSpan = spans.find((span) => span.name === "sandbox.exec");
    expect(stepSpan).toBeTruthy();
    expect(execSpan).toBeTruthy();
    // The unwrapped continuation parents the exec span to the ended step and
    // copies the stale flag.
    expect(execSpan!.parent).toBe(stepSpan);
    expect(execSpan!.attributes[A.execCriticalPath]).toBe(false);
  });
});
