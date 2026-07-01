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

  it("suppresses the buffered onLog dump when the runner reports streamed output, and forwards onOutput", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: { provider: "fake-plugin", reuseLease: false, timeoutMs: 30_000 },
    });

    const executeSpy = vi.fn(async (input: Record<string, unknown>) => {
      // Simulate a streaming provider: deliver output live via onOutput and
      // flag streamed so the runner does not re-log the buffered output.
      const onOutput = input.onOutput as
        | ((stream: "stdout" | "stderr", text: string) => void)
        | undefined;
      onOutput?.("stdout", "live-chunk");
      return { exitCode: 0, timedOut: false, stdout: "live-chunk", stderr: "", streamed: true };
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: { id: "env-1", driver: "sandbox", config: { provider: "fake-plugin" } },
      leaseId: "lease-1",
      leaseMetadata: {},
      lease: { providerLeaseId: "pl-1" } as never,
      environmentRuntime: { execute: executeSpy } as never,
    });

    expect(target?.kind).toBe("remote");
    const runner = (target as { runner?: { execute: (i: unknown) => Promise<unknown> } }).runner!;
    expect(runner).toBeTruthy();

    const logCalls: Array<[string, string]> = [];
    const outputCalls: Array<[string, string]> = [];
    const result = (await runner.execute({
      command: "echo",
      args: ["hi"],
      onLog: async (stream: "stdout" | "stderr", chunk: string) => {
        logCalls.push([stream, chunk]);
      },
      onOutput: (stream: "stdout" | "stderr", text: string) => {
        outputCalls.push([stream, text]);
      },
    })) as { streamed?: boolean; stdout: string };

    // onOutput was threaded into the driver execute and delivered live.
    expect(executeSpy.mock.calls[0][0]).toHaveProperty("onOutput");
    expect(outputCalls).toEqual([["stdout", "live-chunk"]]);
    // The buffered dump is SUPPRESSED because the provider streamed the output.
    expect(logCalls).toEqual([]);
    expect(result.streamed).toBe(true);
    expect(result.stdout).toBe("live-chunk");
  });

  it("still emits the buffered onLog dump for a legacy (non-streamed) runner result", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: { provider: "fake-plugin", reuseLease: false, timeoutMs: 30_000 },
    });

    const executeSpy = vi.fn(async () => ({
      exitCode: 0,
      timedOut: false,
      stdout: "buffered-out",
      stderr: "buffered-err",
      // no `streamed` flag -> legacy behavior
    }));

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: { id: "env-1", driver: "sandbox", config: { provider: "fake-plugin" } },
      leaseId: "lease-1",
      leaseMetadata: {},
      lease: { providerLeaseId: "pl-1" } as never,
      environmentRuntime: { execute: executeSpy } as never,
    });

    const runner = (target as { runner?: { execute: (i: unknown) => Promise<unknown> } }).runner!;
    const logCalls: Array<[string, string]> = [];
    await runner.execute({
      command: "echo",
      onLog: async (stream: "stdout" | "stderr", chunk: string) => {
        logCalls.push([stream, chunk]);
      },
    });

    expect(logCalls).toEqual([
      ["stdout", "buffered-out"],
      ["stderr", "buffered-err"],
    ]);
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
});
