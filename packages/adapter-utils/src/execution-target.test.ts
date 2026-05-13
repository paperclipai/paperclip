import { afterEach, describe, expect, it, vi } from "vitest";
import * as ssh from "./ssh.js";
import * as serverUtils from "./server-utils.js";
import {
  adapterExecutionTargetUsesManagedHome,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  readAdapterExecutionTargetHomeDir,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetSessionIdentity,
  parseAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
} from "./execution-target.js";

describe("describeAdapterExecutionTarget — kubernetes kind", () => {
  it("returns a human-readable description for a kubernetes target", () => {
    const desc = describeAdapterExecutionTarget({
      kind: "kubernetes",
      clusterConnectionId: "c-123",
    });
    expect(desc).toContain("kubernetes");
    expect(desc).toContain("c-123");
  });
});

describe("runAdapterExecutionTargetShellCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("quotes remote shell commands with the shared SSH quoting helper", async () => {
    const runSshCommandSpy = vi.spyOn(ssh, "runSshCommand").mockResolvedValue({
      stdout: "",
      stderr: "",
    });

    await runAdapterExecutionTargetShellCommand(
      "run-1",
      {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/srv/paperclip/workspace",
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
      },
      `printf '%s\\n' "$HOME" && echo "it's ok"`,
      {
        cwd: "/tmp/local",
        env: {},
      },
    );

    // runSshCommand owns profile sourcing and the outer shell wrapper —
    // the caller passes the raw command string. Wrapping it here would
    // double-nest the login shell and re-source profiles after the explicit
    // env override, silently undoing identity-var preservation.
    expect(runSshCommandSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "ssh.example.test",
        username: "ssh-user",
      }),
      `printf '%s\\n' "$HOME" && echo "it's ok"`,
      expect.any(Object),
    );
  });

  it("sanitizes inherited host env before SSH shell execution", async () => {
    vi.stubEnv("PATH", "/host/bin:/usr/bin");
    vi.stubEnv("HOME", "/Users/local");

    const runSshCommandSpy = vi.spyOn(ssh, "runSshCommand").mockResolvedValue({
      stdout: "",
      stderr: "",
    });

    await runAdapterExecutionTargetShellCommand(
      "run-1b",
      {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/srv/paperclip/workspace",
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
      },
      "env",
      {
        cwd: "/tmp/local",
        env: {
          PATH: "/host/bin:/usr/bin",
          HOME: "/Users/local",
          SAFE_VALUE: "visible",
        },
      },
    );

    expect(runSshCommandSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
      expect.objectContaining({
        env: {
          SAFE_VALUE: "visible",
        },
      }),
    );
  });

  it("returns a timedOut result when the SSH shell command times out", async () => {
    vi.spyOn(ssh, "runSshCommand").mockRejectedValue(Object.assign(new Error("timed out"), {
      code: "ETIMEDOUT",
      stdout: "partial stdout",
      stderr: "partial stderr",
      signal: "SIGTERM",
    }));
    const onLog = vi.fn(async () => {});

    const result = await runAdapterExecutionTargetShellCommand(
      "run-2",
      {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/srv/paperclip/workspace",
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
      },
      "sleep 10",
      {
        cwd: "/tmp/local",
        env: {},
        onLog,
      },
    );

    expect(result).toMatchObject({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      stdout: "partial stdout",
      stderr: "partial stderr",
    });
    expect(onLog).toHaveBeenCalledWith("stdout", "partial stdout");
    expect(onLog).toHaveBeenCalledWith("stderr", "partial stderr");
  });

  it("returns the SSH process exit code for non-zero remote command failures", async () => {
    vi.spyOn(ssh, "runSshCommand").mockRejectedValue(Object.assign(new Error("non-zero exit"), {
      code: 17,
      stdout: "partial stdout",
      stderr: "partial stderr",
      signal: null,
    }));
    const onLog = vi.fn(async () => {});

    const result = await runAdapterExecutionTargetShellCommand(
      "run-3",
      {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/srv/paperclip/workspace",
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
      },
      "false",
      {
        cwd: "/tmp/local",
        env: {},
        onLog,
      },
    );

    expect(result).toMatchObject({
      exitCode: 17,
      signal: null,
      timedOut: false,
      stdout: "partial stdout",
      stderr: "partial stderr",
    });
    expect(onLog).toHaveBeenCalledWith("stdout", "partial stdout");
    expect(onLog).toHaveBeenCalledWith("stderr", "partial stderr");
  });

  it("keeps managed homes disabled for both local and SSH targets", () => {
    expect(adapterExecutionTargetUsesManagedHome(null)).toBe(false);
    expect(adapterExecutionTargetUsesManagedHome({
      kind: "remote",
      transport: "ssh",
      remoteCwd: "/srv/paperclip/workspace",
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteCwd: "/srv/paperclip/workspace",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    })).toBe(false);
  });
});

describe("runAdapterExecutionTargetProcess", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("sanitizes inherited host env before SSH process execution", async () => {
    vi.stubEnv("PATH", "/host/bin:/usr/bin");
    vi.stubEnv("HOME", "/Users/local");

    const runChildProcessSpy = vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: new Date().toISOString(),
    });

    await runAdapterExecutionTargetProcess(
      "run-ssh-process",
      {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/srv/paperclip/workspace",
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
      },
      "agent-cli",
      ["--json"],
      {
        cwd: "/tmp/local",
        env: {
          PATH: "/host/bin:/usr/bin",
          HOME: "/Users/local",
          SAFE_VALUE: "visible",
        },
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
      },
    );

    expect(runChildProcessSpy).toHaveBeenCalledWith(
      "run-ssh-process",
      "agent-cli",
      ["--json"],
      expect.objectContaining({
        env: {
          SAFE_VALUE: "visible",
        },
      }),
    );
  });
});

describe("ensureAdapterExecutionTargetRuntimeCommandInstalled", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs install commands for sandbox targets", async () => {
    const runner = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };

    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId: "run-install",
      target: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "e2b",
        remoteCwd: "/remote/workspace",
        runner,
      },
      installCommand: "npm install -g @google/gemini-cli",
      cwd: "/local/workspace",
      env: { PATH: "/usr/bin" },
      timeoutSec: 30,
    });

    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: "sh",
      args: ["-c", "npm install -g @google/gemini-cli"],
      cwd: "/remote/workspace",
      env: { PATH: "/usr/bin" },
      timeoutMs: 30_000,
    }));
  });

  it("skips install commands for SSH targets", async () => {
    const runSshCommandSpy = vi.spyOn(ssh, "runSshCommand").mockResolvedValue({
      stdout: "",
      stderr: "",
    });

    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId: "run-skip",
      target: {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/srv/paperclip/workspace",
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
      },
      installCommand: "npm install -g @google/gemini-cli",
      cwd: "/tmp/local",
      env: {},
    });

    expect(runSshCommandSpy).not.toHaveBeenCalled();
  });
});

describe("resolveAdapterExecutionTargetCwd", () => {
  const sshTarget = {
    kind: "remote" as const,
    transport: "ssh" as const,
    remoteCwd: "/srv/paperclip/workspace",
    spec: {
      host: "ssh.example.test",
      port: 22,
      username: "ssh-user",
      remoteCwd: "/srv/paperclip/workspace",
      remoteWorkspacePath: "/srv/paperclip/workspace",
      privateKey: null,
      knownHosts: null,
      strictHostKeyChecking: true,
    },
  };

  it("falls back to the remote cwd when no adapter cwd is configured", () => {
    expect(resolveAdapterExecutionTargetCwd(sshTarget, "", "/Users/host/repo/server")).toBe(
      "/srv/paperclip/workspace",
    );
    expect(resolveAdapterExecutionTargetCwd(sshTarget, "   ", "/Users/host/repo/server")).toBe(
      "/srv/paperclip/workspace",
    );
    expect(resolveAdapterExecutionTargetCwd(sshTarget, null, "/Users/host/repo/server")).toBe(
      "/srv/paperclip/workspace",
    );
  });

  it("preserves an explicit adapter cwd when one is configured", () => {
    expect(
      resolveAdapterExecutionTargetCwd(
        sshTarget,
        "/srv/paperclip/custom-agent-dir",
        "/Users/host/repo/server",
      ),
    ).toBe("/srv/paperclip/custom-agent-dir");
  });

  it("keeps the local fallback cwd for local targets", () => {
    expect(resolveAdapterExecutionTargetCwd(null, "", "/Users/host/repo/server")).toBe(
      "/Users/host/repo/server",
    );
  });
});

describe("kubernetes kind: runtime helpers explicitly throw M1-not-implemented", () => {
  const target = { kind: "kubernetes" as const, clusterConnectionId: "c-1" };

  it("resolveAdapterExecutionTargetCwd throws", () => {
    expect(() => resolveAdapterExecutionTargetCwd(target, null, "/fallback")).toThrow(/not implemented/i);
  });

  it("ensureAdapterExecutionTargetCommandResolvable throws", async () => {
    await expect(
      ensureAdapterExecutionTargetCommandResolvable("node", target, "/cwd", process.env),
    ).rejects.toThrow(/not implemented/i);
  });

  it("runAdapterExecutionTargetProcess throws", async () => {
    await expect(
      runAdapterExecutionTargetProcess("r-1", target, "node", [], {
        cwd: "/",
        env: {},
        timeoutSec: 1,
        graceSec: 1,
        onLog: async () => {},
      }),
    ).rejects.toThrow(/not implemented/i);
  });

  it("runAdapterExecutionTargetShellCommand throws", async () => {
    await expect(
      runAdapterExecutionTargetShellCommand("r-1", target, "echo hi", { cwd: "/", env: {} }),
    ).rejects.toThrow(/not implemented/i);
  });

  it("readAdapterExecutionTargetHomeDir throws", async () => {
    await expect(
      readAdapterExecutionTargetHomeDir("r-1", target, { cwd: "/", env: {} }),
    ).rejects.toThrow(/not implemented/i);
  });

  it("resolveAdapterExecutionTargetCommandForLogs throws", async () => {
    await expect(
      resolveAdapterExecutionTargetCommandForLogs("node", target, "/cwd", process.env),
    ).rejects.toThrow(/not implemented/i);
  });
});

describe("adapterExecutionTargetSessionMatches — kubernetes namespaceOverride", () => {
  it("returns false when saved namespaceOverride differs from current", () => {
    const saved = adapterExecutionTargetSessionIdentity({
      kind: "kubernetes",
      clusterConnectionId: "c-123",
      namespaceOverride: "ns-a",
    });
    expect(
      adapterExecutionTargetSessionMatches(saved, {
        kind: "kubernetes",
        clusterConnectionId: "c-123",
        namespaceOverride: "ns-b",
      }),
    ).toBe(false);
  });

  it("returns true when saved namespaceOverride matches current", () => {
    const saved = adapterExecutionTargetSessionIdentity({
      kind: "kubernetes",
      clusterConnectionId: "c-123",
      namespaceOverride: "ns-a",
    });
    expect(
      adapterExecutionTargetSessionMatches(saved, {
        kind: "kubernetes",
        clusterConnectionId: "c-123",
        namespaceOverride: "ns-a",
      }),
    ).toBe(true);
  });

  it("returns true when neither saved nor current has a namespaceOverride", () => {
    const saved = adapterExecutionTargetSessionIdentity({
      kind: "kubernetes",
      clusterConnectionId: "c-123",
    });
    expect(
      adapterExecutionTargetSessionMatches(saved, {
        kind: "kubernetes",
        clusterConnectionId: "c-123",
      }),
    ).toBe(true);
  });
});

describe("parseAdapterExecutionTarget — kubernetes round-trip", () => {
  it("round-trips all five non-id fields without data loss", () => {
    const input = {
      kind: "kubernetes" as const,
      clusterConnectionId: "c-456",
      namespaceOverride: "my-ns",
      imageOverride: "my-registry/agent:v2",
      resources: {
        requests: { cpu: "500m", memory: "512Mi" },
        limits: { cpu: "1000m", memory: "1Gi" },
      },
      storage: { sizeGi: 10, storageClass: "fast-ssd" },
      envOverrides: { MY_VAR: "hello", ANOTHER: "world" },
    };

    const result = parseAdapterExecutionTarget(input);

    expect(result).not.toBeNull();
    expect(result?.kind).toBe("kubernetes");
    if (result?.kind !== "kubernetes") return;

    expect(result.clusterConnectionId).toBe("c-456");
    expect(result.namespaceOverride).toBe("my-ns");
    expect(result.imageOverride).toBe("my-registry/agent:v2");
    expect(result.resources).toEqual(input.resources);
    expect(result.storage).toEqual(input.storage);
    expect(result.envOverrides).toEqual(input.envOverrides);
  });
});

describe("describeAdapterExecutionTarget — kubernetes namespaceOverride", () => {
  it("includes both clusterConnectionId and namespaceOverride in description", () => {
    const desc = describeAdapterExecutionTarget({
      kind: "kubernetes",
      clusterConnectionId: "c-123",
      namespaceOverride: "my-ns",
    });
    expect(desc).toContain("c-123");
    expect(desc).toContain("my-ns");
  });
});
