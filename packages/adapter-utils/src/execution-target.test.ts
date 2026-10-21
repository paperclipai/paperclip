import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ssh from "./ssh.js";
import * as serverUtils from "./server-utils.js";
import {
  cleanupGitHubOperationLaunchers,
  prepareGitHubOperationLaunchers,
  adapterExecutionTargetUsesManagedHome,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  type AdapterSshExecutionTarget,
} from "./execution-target.js";

function sshExecutionTarget(): AdapterSshExecutionTarget {
  return {
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
  };
}

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
      sshExecutionTarget(),
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
      sshExecutionTarget(),
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
      sshExecutionTarget(),
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
      sshExecutionTarget(),
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

  it.each([true, false, undefined])("preserves the sandbox session choice %s and command outcome", async (useSession) => {
    const stopped = vi.fn();
    const onLog = vi.fn(async (_stream: "stdout" | "stderr", _chunk: string) => {});
    const completed = {
      exitCode: 7, signal: null, timedOut: false, stdout: "partial output",
      stderr: "fixture failure", pid: null, startedAt: "2020-01-01T00:00:00.000Z",
    };
    const execute = vi.fn(async (input: { onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> }) => {
      await input.onLog?.("stdout", completed.stdout);
      return completed;
    });
    const result = await runAdapterExecutionTargetProcess("run-fixture", {
      kind: "remote", transport: "sandbox", remoteCwd: "/workspace", runner: { execute },
    }, "opencode", ["run"], {
      cwd: "/local", env: {}, timeoutSec: 14400, graceSec: 20,
      onLog, onProcessStopped: stopped, ...(useSession === undefined ? {} : { useSession }),
    });
    const call = execute.mock.calls[0]![0];
    expect(call).toMatchObject({ command: "opencode", args: ["run"], cwd: "/workspace", timeoutMs: 14400000 });
    if (useSession === undefined) expect(call).not.toHaveProperty("useSession");
    else expect(call).toHaveProperty("useSession", useSession);
    if (useSession === true) expect(call).toHaveProperty("commandTimeoutMs", 14400000);
    else expect(call).not.toHaveProperty("commandTimeoutMs");
    expect(result).toEqual(completed);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(onLog.mock.calls).toEqual([["stdout", "partial output"]]);
    expect(stopped).toHaveBeenCalledTimes(1);
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
      sshExecutionTarget(),
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
        useSession: true,
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
    expect(runChildProcessSpy.mock.calls[0]![3]).not.toHaveProperty("useSession");
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
      target: sshExecutionTarget(),
      installCommand: "npm install -g @google/gemini-cli",
      cwd: "/tmp/local",
      env: {},
    });

    expect(runSshCommandSpy).not.toHaveBeenCalled();
  });
});

describe("resolveAdapterExecutionTargetCwd", () => {
  const sshTarget = sshExecutionTarget();

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


describe("GitHub launcher lifecycle", () => {
  it("removes only the completed run's launchers and leaves concurrent runs usable", async () => {
    const first = { runId: randomUUID(), target: null };
    const second = { runId: randomUUID(), target: null };
    try {
      const a = await prepareGitHubOperationLaunchers({ ...first, cwd: "/tmp", env: {} });
      const b = await prepareGitHubOperationLaunchers({ ...second, cwd: "/tmp", env: {} });
      await cleanupGitHubOperationLaunchers(first);
      await expect(access(a.PAPERCLIP_GITHUB_LAUNCHER_DIR)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(`${b.PAPERCLIP_GITHUB_LAUNCHER_DIR}/git`, "utf8")).toContain("PAPERCLIP_GITHUB_BROKER_URL");
      await cleanupGitHubOperationLaunchers(first); // teardown replay is harmless
    } finally {
      await cleanupGitHubOperationLaunchers(first);
      await cleanupGitHubOperationLaunchers(second);
    }
  });

  it("bounds remote cleanup to one run and rejects traversal", async () => {
    const runner = { execute: vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false,
      stdout: "", stderr: "", pid: null, startedAt: new Date().toISOString() })) };
    const target = { kind: "remote" as const, transport: "sandbox" as const,
      providerKey: "e2b", remoteCwd: "/remote/workspace", runner };
    await cleanupGitHubOperationLaunchers({ runId: "finished-run", target });
    expect(runner.execute).toHaveBeenCalledWith({ command: "sh",
      args: ["-c", "rm -rf -- '/remote/workspace/.paperclip-runtime/paperclip-runner/github/finished-run'"],
      cwd: "/remote/workspace", timeoutMs: 5_000 });
    await expect(cleanupGitHubOperationLaunchers({ runId: "../other", target })).rejects.toThrow("Invalid GitHub launcher run ID");
    expect(runner.execute).toHaveBeenCalledTimes(1);
  });
});
