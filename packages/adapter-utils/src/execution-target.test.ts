import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ssh from "./ssh.js";
import * as serverUtils from "./server-utils.js";
import {
  adapterExecutionTargetUsesManagedHome,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  preparePaperclipControlPlaneEnvForAdapterRun,
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

describe("preparePaperclipControlPlaneEnvForAdapterRun", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it(
    "keeps the probe alive long enough to reach a later candidate when earlier candidates consume the old 5s budget",
    async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-preflight-budget-"));
    const delayedServers = Array.from({ length: 2 }, () =>
      createServer((req, res) => {
        if (req.url === "/api/agents/me") {
          setTimeout(() => {
            if (!res.writableEnded) {
              res.writeHead(504, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "late_timeout" }));
            }
          }, 10_000);
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      }),
    );
    const reachableServer = createServer((req, res) => {
      if (req.url === "/api/agents/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "agent-1" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });

    await Promise.all(
      delayedServers.map(
        (server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve())),
      ),
    );
    await new Promise<void>((resolve) => reachableServer.listen(0, "127.0.0.1", () => resolve()));

    const delayedCandidates = delayedServers.map((server) => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected delayed probe server to expose a TCP port");
      return `http://127.0.0.1:${address.port}`;
    });
    const reachableAddress = reachableServer.address();
    if (!reachableAddress || typeof reachableAddress === "string") {
      throw new Error("Expected reachable probe server to expose a TCP port");
    }
    const reachableUrl = `http://127.0.0.1:${reachableAddress.port}`;

    vi.stubEnv("PAPERCLIP_RUNTIME_API_URL", delayedCandidates[0]);
    vi.stubEnv(
      "PAPERCLIP_RUNTIME_API_CANDIDATES_JSON",
      JSON.stringify([...delayedCandidates, reachableUrl]),
    );

    const runChildProcessSpy = vi.spyOn(serverUtils, "runChildProcess");
    const env: Record<string, string> = {
      PAPERCLIP_API_KEY: "run-jwt-token",
      PAPERCLIP_API_URL: delayedCandidates[0]!,
    };

    try {
      const result = await preparePaperclipControlPlaneEnvForAdapterRun({
        adapterLabel: "codex",
        runId: "run-preflight-time-budget",
        target: null,
        cwd,
        env,
        timeoutSec: 0,
        graceSec: 2,
      });

      expect(result).toMatchObject({
        ok: true,
        skipped: false,
        changed: true,
        url: reachableUrl,
      });
      expect(env.PAPERCLIP_API_URL).toBe(reachableUrl);
      expect(result.attempts).toHaveLength(3);
      expect(result.attempts.at(-1)).toMatchObject({
        url: reachableUrl,
        status: 200,
      });
      expect(runChildProcessSpy).toHaveBeenCalledWith(
        expect.any(String),
        process.execPath,
        expect.any(Array),
        expect.objectContaining({
          timeoutSec: 16,
        }),
      );
    } finally {
      await Promise.all(
        delayedServers.map(
          (server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
        ),
      );
      await new Promise<void>((resolve, reject) => reachableServer.close((error) => (error ? reject(error) : resolve())));
      await fs.rm(cwd, { recursive: true, force: true });
    }
    },
    20_000,
  );

  it("prefers a private runtime candidate when the probe process dies before producing a verdict", async () => {
    vi.stubEnv("PAPERCLIP_RUNTIME_API_URL", "https://gated.example.test");
    vi.stubEnv(
      "PAPERCLIP_RUNTIME_API_CANDIDATES_JSON",
      JSON.stringify(["https://gated.example.test", "http://127.0.0.1:3100"]),
    );
    vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: new Date().toISOString(),
    });

    const env: Record<string, string> = {
      PAPERCLIP_API_KEY: "run-jwt-token",
      PAPERCLIP_API_URL: "https://gated.example.test",
    };
    const logs: string[] = [];

    const result = await preparePaperclipControlPlaneEnvForAdapterRun({
      adapterLabel: "claude ACPX",
      runId: "run-preflight-fail-open",
      target: null,
      cwd: process.cwd(),
      env,
      timeoutSec: 0,
      graceSec: 2,
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });

    expect(result).toMatchObject({
      ok: true,
      skipped: true,
      changed: true,
      url: "http://127.0.0.1:3100",
      reasons: ["probe_infra_failure"],
    });
    expect(env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:3100");
    expect(logs.join("")).toContain("fail-open -> http://127.0.0.1:3100 instead of https://gated.example.test");
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
