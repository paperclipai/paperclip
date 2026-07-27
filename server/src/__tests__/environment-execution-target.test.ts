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
      execCount(): number;
      providerExecMs(): number;
      providerGetMs(): number;
      execute(input: { command: string; args?: string[] }): Promise<unknown>;
    } }).runner;
    expect(runner).toBeTruthy();
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
});
