import fs from "node:fs/promises";
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
    const delayedCandidates = [
      "http://127.0.0.1:41001",
      "http://127.0.0.1:41002",
    ];
    const reachableUrl = "http://127.0.0.1:41003";

    vi.stubEnv("PAPERCLIP_RUNTIME_API_URL", delayedCandidates[0]);
    vi.stubEnv(
      "PAPERCLIP_RUNTIME_API_CANDIDATES_JSON",
      JSON.stringify([...delayedCandidates, reachableUrl]),
    );

    const runChildProcessSpy = vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({
        ok: true,
        url: reachableUrl,
        status: 200,
        attempts: [
          {
            url: delayedCandidates[0],
            status: null,
            error: "The operation was aborted",
          },
          {
            url: delayedCandidates[1],
            status: null,
            error: "The operation was aborted",
          },
          {
            url: reachableUrl,
            status: 200,
            contentType: "application/json",
          },
        ],
      }),
      stderr: "",
      pid: null,
      startedAt: new Date().toISOString(),
    });
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
          timeoutSec: 21,
        }),
      );
    } finally {
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

  it("treats a 200 text/html candidate as unreachable and advances to a JSON API origin", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-preflight-html-"));
    const htmlUrl = "http://127.0.0.1:42001";
    const reachableUrl = "http://127.0.0.1:42002";

    vi.stubEnv("PAPERCLIP_RUNTIME_API_URL", htmlUrl);
    vi.stubEnv(
      "PAPERCLIP_RUNTIME_API_CANDIDATES_JSON",
      JSON.stringify([htmlUrl, reachableUrl]),
    );
    vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({
        ok: true,
        url: reachableUrl,
        status: 200,
        attempts: [
          {
            url: htmlUrl,
            status: 200,
            contentType: "text/html",
          },
          {
            url: reachableUrl,
            status: 200,
            contentType: "application/json",
          },
        ],
      }),
      stderr: "",
      pid: null,
      startedAt: new Date().toISOString(),
    });

    const env: Record<string, string> = {
      PAPERCLIP_API_KEY: "run-jwt-token",
      PAPERCLIP_API_URL: htmlUrl,
    };

    try {
      const result = await preparePaperclipControlPlaneEnvForAdapterRun({
        adapterLabel: "codex",
        runId: "run-preflight-html",
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
      expect(result.attempts).toMatchObject([
        {
          url: htmlUrl,
          status: 200,
          contentType: "text/html",
        },
        {
          url: reachableUrl,
          status: 200,
          contentType: "application/json",
        },
      ]);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to the runtime listen loopback when the exported API URL is gateway-gated", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-preflight-loopback-"));
    const reachableUrl = "http://127.0.0.1:43001";

    vi.stubEnv("PAPERCLIP_RUNTIME_API_URL", "https://paperclip.quote-to-invoice.ai");
    vi.stubEnv("PAPERCLIP_RUNTIME_API_CANDIDATES_JSON", JSON.stringify(["https://paperclip.quote-to-invoice.ai"]));
    vi.stubEnv("PAPERCLIP_LISTEN_HOST", "127.0.0.1");
    vi.stubEnv("PAPERCLIP_LISTEN_PORT", "43001");
    vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({
        ok: true,
        url: reachableUrl,
        status: 200,
        attempts: [
          {
            url: "https://paperclip.quote-to-invoice.ai",
            status: 302,
            location: "https://quote-to-invoice.cloudflareaccess.com/cdn-cgi/access/login/paperclip",
            contentType: "text/html",
          },
          {
            url: reachableUrl,
            status: 200,
            contentType: "application/json",
          },
        ],
      }),
      stderr: "",
      pid: null,
      startedAt: new Date().toISOString(),
    });

    const env: Record<string, string> = {
      PAPERCLIP_API_KEY: "run-jwt-token",
      PAPERCLIP_API_URL: "https://paperclip.quote-to-invoice.ai",
    };

    try {
      const result = await preparePaperclipControlPlaneEnvForAdapterRun({
        adapterLabel: "codex",
        runId: "run-preflight-loopback",
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
      expect(result.attempts).toMatchObject([
        {
          url: "https://paperclip.quote-to-invoice.ai",
        },
        {
          url: reachableUrl,
          status: 200,
          contentType: "application/json",
        },
      ]);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
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
