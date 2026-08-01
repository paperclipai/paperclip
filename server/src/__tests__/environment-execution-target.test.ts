import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveEnvironmentDriverConfigForRuntime } = vi.hoisted(() => ({
  mockResolveEnvironmentDriverConfigForRuntime: vi.fn(),
}));

vi.mock("../services/environment-config.js", () => ({
  resolveEnvironmentDriverConfigForRuntime: mockResolveEnvironmentDriverConfigForRuntime,
}));

import {
  DEFAULT_SANDBOX_REMOTE_CWD,
  resolveEnvironmentExecutionTarget,
} from "../services/environment-execution-target.js";

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

  it("exposes a sandbox runner that counts round-trips and accumulates provider durations", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    // Each exec reports its provider-boundary durations on the free-form result
    // metadata (the Daytona plugin does this); the runner accumulates them.
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
      execCount(): number;
      providerExecMs(): number;
      providerGetMs(): number;
      execute(input: { command: string; args?: string[] }): Promise<unknown>;
    } }).runner;
    expect(runner).toBeTruthy();
    // Single-stream stdin upload is enabled (research A1 / PAP-3159 #2): a
    // ≤96 MiB writeFile collapses to one round-trip.
    expect(runner!.supportsSingleStreamStdinProgress).toBe(false);
    expect(runner!.execCount()).toBe(0);
    expect(runner!.providerExecMs()).toBe(0);
    expect(runner!.providerGetMs()).toBe(0);

    await runner!.execute({ command: "echo", args: ["a"] });
    await runner!.execute({ command: "echo", args: ["b"] });

    expect(runner!.execCount()).toBe(2);
    expect(runner!.providerExecMs()).toBe(1200);
    expect(runner!.providerGetMs()).toBe(30);
  });

  it("tolerates a provider result with no timing metadata (counts the round-trip, accumulates nothing)", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: { provider: "fake-plugin", reuseLease: false, timeoutMs: 30_000 },
    });

    const environmentRuntime = {
      execute: vi.fn().mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
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
      execCount(): number;
      providerExecMs(): number;
      providerGetMs(): number;
      execute(input: { command: string }): Promise<unknown>;
    } }).runner;
    await runner!.execute({ command: "echo" });

    expect(runner!.execCount()).toBe(1);
    expect(runner!.providerExecMs()).toBe(0);
    expect(runner!.providerGetMs()).toBe(0);
  });

  // A recording tracer that captures each provider-exec span's name, attribute
  // map, and end. It satisfies the structural tracer the seam calls.
  function createRecordingExecTracer() {
    const spans: Array<{ name: string; attributes: Record<string, unknown>; ended: boolean }> = [];
    const tracer = {
      startSpan(name: string) {
        const span = {
          name,
          attributes: {} as Record<string, unknown>,
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
    return { tracer, spans };
  }

  // The closed span-attribute allowlist for a provider-exec span (Phase 4).
  const ALLOWED_EXEC_SPAN_ATTRIBUTE_KEYS = new Set([
    "provider",
    "exit",
    "provider.exec.duration_ms",
    "provider.get.duration_ms",
  ]);

  async function runnerFor(input: {
    provider: string;
    execResult: Record<string, unknown>;
    tracer: unknown;
  }) {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: { provider: input.provider, reuseLease: false, timeoutMs: 30_000 },
    });
    const environmentRuntime = {
      execute: vi.fn().mockResolvedValue(input.execResult),
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
    expect(span.name).toBe("provider.execute");
    expect(span.ended).toBe(true);
    expect(span.attributes["provider.exec.duration_ms"]).toBe(600);
    expect(span.attributes["provider.get.duration_ms"]).toBe(15);
    expect(span.attributes.provider).toBe("daytona");
    expect(span.attributes.exit).toBe("ok");
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
    expect("provider.exec.duration_ms" in span.attributes).toBe(false);
    expect("provider.get.duration_ms" in span.attributes).toBe(false);
    // The provider attribute is always present so a trace shows which provider ran.
    expect(span.attributes.provider).toBe("kubernetes");
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
    expect("provider.exec.duration_ms" in span.attributes).toBe(false);
    expect(span.attributes["provider.get.duration_ms"]).toBe(20);
    expect(span.attributes.exit).toBe("error");
  });

  it("never sets a command, arg, or non-allowlisted key as an indexed span attribute", async () => {
    const { tracer, spans } = createRecordingExecTracer();
    const runner = await runnerFor({
      provider: "daytona",
      execResult: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        metadata: { durationMs: 5, getDurationMs: 1 },
      },
      tracer,
    });

    await runner.execute({ command: "bash -lc 'rm -rf /secret/path'", args: ["--token", "s3cr3t"] });

    const span = spans[0]!;
    for (const key of Object.keys(span.attributes)) {
      expect(ALLOWED_EXEC_SPAN_ATTRIBUTE_KEYS.has(key), `non-allowlisted key "${key}"`).toBe(true);
    }
    const values = Object.values(span.attributes).map(String);
    expect(values.some((value) => value.includes("rm -rf"))).toBe(false);
    expect(values.some((value) => value.includes("s3cr3t"))).toBe(false);
  });

  it("normalizes a plugin-backed provider key to `plugin` and keeps a built-in family as-is", async () => {
    const plugin = createRecordingExecTracer();
    const pluginRunner = await runnerFor({
      provider: "acme-custom-sandbox",
      execResult: { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" },
      tracer: plugin.tracer,
    });
    await pluginRunner.execute({ command: "echo" });
    expect(plugin.spans[0]!.attributes.provider).toBe("plugin");

    const builtIn = createRecordingExecTracer();
    const builtInRunner = await runnerFor({
      provider: "e2b",
      execResult: { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" },
      tracer: builtIn.tracer,
    });
    await builtInRunner.execute({ command: "echo" });
    expect(builtIn.spans[0]!.attributes.provider).toBe("e2b");
  });
});
