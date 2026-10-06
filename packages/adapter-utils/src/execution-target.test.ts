import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
} from "./execution-target.js";

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
      args: ["-c", "rm -rf -- '/remote/workspace/.paperclip-runtime/github/finished-run'"],
      cwd: "/remote/workspace", timeoutMs: 5_000 });
    await expect(cleanupGitHubOperationLaunchers({ runId: "../other", target })).rejects.toThrow("Invalid GitHub launcher run ID");
    expect(runner.execute).toHaveBeenCalledTimes(1);
  });
});


describe("sandbox wake payload retries", () => {
  it.each(["none", "transfer", "adapter"])(
    "preserves the host source across two attempts after %s failure",
    async (failure) => {
      const scratch = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-sandbox-retry-"));
      const payload = JSON.stringify({ marker: "pełny kontekst", history: "x".repeat(600 * 1024) });
      const env: Record<string, string> = {
        PAPERCLIP_WAKE_PAYLOAD_JSON: payload,
        PAPERCLIP_RUN_SCRATCH_DIR: scratch,
      };
      const ok = { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: new Date().toISOString() };
      const execute = vi.fn().mockResolvedValue(ok);
      if (failure === "transfer") execute.mockResolvedValueOnce({ ...ok, exitCode: 1 });
      if (failure === "adapter") {
        execute.mockResolvedValueOnce(ok).mockResolvedValueOnce({ ...ok, exitCode: 1 });
      }
      const target = { kind: "remote" as const, transport: "sandbox" as const,
        providerKey: "test", remoteCwd: "/remote/workspace", runner: { execute } };
      const options = { cwd: scratch, env, timeoutSec: 30, graceSec: 1, onLog: vi.fn() };
      const runId = randomUUID();
      try {
        const first = runAdapterExecutionTargetProcess(runId, target, "claude", ["--resume", "session"], options);
        if (failure === "transfer") await expect(first).rejects.toThrow("Failed to publish");
        else expect((await first).exitCode).toBe(failure === "adapter" ? 1 : 0);

        const second = await runAdapterExecutionTargetProcess(runId, target, "claude", [], options);
        expect(second.exitCode).toBe(0);
        const transfers = execute.mock.calls.map(([input]) => input).filter((input) => input.command === "sh");
        const adapters = execute.mock.calls.map(([input]) => input).filter((input) => input.command === "claude");
        expect(transfers).toHaveLength(2);
        expect(adapters).toHaveLength(failure === "transfer" ? 1 : 2);
        for (const transfer of transfers) expect(transfer.stdin).toBe(payload);
        for (const adapter of adapters) {
          const pointer = JSON.parse(adapter.env.PAPERCLIP_WAKE_PAYLOAD_JSON);
          expect(pointer.path).toBe(adapter.env.PAPERCLIP_WAKE_PAYLOAD_PATH);
          expect(pointer.path).not.toBe(env.PAPERCLIP_WAKE_PAYLOAD_PATH);
          expect(pointer.bytes).toBe(Buffer.byteLength(payload));
          expect(adapter.env.PAPERCLIP_WAKE_PAYLOAD_LOCAL_PATH).toBeUndefined();
          expect(adapter.env.PAPERCLIP_WAKE_PAYLOAD_JSON).not.toContain("pełny kontekst");
        }
        expect(env.PAPERCLIP_WAKE_PAYLOAD_LOCAL_PATH).toBe(env.PAPERCLIP_WAKE_PAYLOAD_PATH);
        expect(JSON.parse(env.PAPERCLIP_WAKE_PAYLOAD_JSON).path).toBe(env.PAPERCLIP_WAKE_PAYLOAD_PATH);
        expect(await readFile(env.PAPERCLIP_WAKE_PAYLOAD_LOCAL_PATH!, "utf8")).toBe(payload);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  );
});

describe("wake pointer transport boundary", () => {
  it.each(["local", "sandbox", "ssh"])(
    "%s start validates the agent path or publishes the retained host source",
    async (transport) => {
      const { materializePaperclipWakePayloadEnv, rewritePaperclipWakePayloadPointerPath } =
        await import("./wake-payload-env.js");
      const scratch = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-transport-"));
      const payload = JSON.stringify({ history: "context".repeat(100_000) });
      const env: Record<string, string> = { PAPERCLIP_WAKE_PAYLOAD_JSON: payload };
      const ok = { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: new Date().toISOString() };
      const execute = vi.fn().mockResolvedValue(ok);
      const child = vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue(ok);
      const options = { cwd: scratch, env, timeoutSec: 30, graceSec: 1, onLog: vi.fn() };
      const target = transport === "local" ? null : transport === "sandbox"
        ? { kind: "remote" as const, transport: "sandbox" as const,
            providerKey: "test", remoteCwd: "/remote/workspace", runner: { execute } }
        : { kind: "remote" as const, transport: "ssh" as const, remoteCwd: "/remote/workspace",
            spec: { host: "ssh.example.test", port: 22, username: "test", remoteCwd: "/remote/workspace",
              remoteWorkspacePath: "/remote/workspace", privateKey: null, knownHosts: null, strictHostKeyChecking: true } };
      try {
        await materializePaperclipWakePayloadEnv(env, { runId: "transport", scratchDir: scratch });
        rewritePaperclipWakePayloadPointerPath(env, path.join(scratch, "absent-agent-copy.json"));
        // A stale marker from an earlier hand-off must never authorize a local start.
        env.PAPERCLIP_WAKE_PAYLOAD_REMOTE = "1";
        for (let attempt = 0; attempt < 2; attempt++) {
          const start = runAdapterExecutionTargetProcess("transport", target, "claude", [], options);
          if (transport === "local") await expect(start).rejects.toThrow("Refusing to start");
          else expect((await start).exitCode).toBe(0);
        }
        expect(await readFile(env.PAPERCLIP_WAKE_PAYLOAD_LOCAL_PATH!, "utf8")).toBe(payload);
        if (transport === "local") {
          expect(child).not.toHaveBeenCalled();
          expect(execute).not.toHaveBeenCalled();
        } else if (transport === "sandbox") {
          expect(execute.mock.calls.filter(([input]) => input.command === "sh").map(([input]) => input.stdin))
            .toEqual([payload, payload]);
        } else {
          expect(child).toHaveBeenCalledTimes(2);
          expect(child.mock.calls[0]?.[3]).toMatchObject({ remoteExecution: expect.objectContaining({ host: "ssh.example.test" }),
            env: { PAPERCLIP_WAKE_PAYLOAD_LOCAL_PATH: env.PAPERCLIP_WAKE_PAYLOAD_LOCAL_PATH } });
        }
        delete env.PAPERCLIP_WAKE_PAYLOAD_LOCAL_PATH;
        await expect(runAdapterExecutionTargetProcess("transport", target, "claude", [], options))
          .rejects.toThrow("Refusing to start");
      } finally {
        vi.restoreAllMocks();
        await rm(scratch, { recursive: true, force: true });
      }
    },
  );
});
