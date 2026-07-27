import { afterEach, describe, expect, it, vi } from "vitest";
import * as ssh from "./ssh.js";
import * as serverUtils from "./server-utils.js";
import {
  adapterExecutionTargetUsesManagedHome,
  BridgeResponseBodyTooLargeError,
  createPaperclipBridgeForwardRequestHandler,
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

describe("createPaperclipBridgeForwardRequestHandler", () => {
  const baseRequest = {
    method: "GET",
    path: "/api/agents/me",
    query: "",
    headers: { accept: "application/json" },
    body: "",
  };

  const makeHandler = (fetchImpl: typeof fetch, maxBodyBytes = 64) =>
    createPaperclipBridgeForwardRequestHandler({
      runId: "run-bridge-map",
      hostApiUrl: "http://127.0.0.1:9",
      hostApiToken: "host-token",
      maxBodyBytes,
      fetchImpl,
    });

  it("relays a successful upstream response verbatim", async () => {
    const handler = makeHandler(async () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await handler(baseRequest);

    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toBe("application/json");
    expect(result.body).toBe('{"ok":true}');
  });

  it("maps an oversized response body to a 413 with the too-large code", async () => {
    const handler = makeHandler(async () =>
      new Response("x".repeat(1024), {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );

    const result = await handler(baseRequest);

    expect(result.status).toBe(413);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body.code).toBe("bridge_response_too_large");
    // The upstream call itself succeeded; only relaying the payload failed.
    expect(body.upstreamStatus).toBe(200);
  });

  it("maps a mid-stream body read failure to a 502, not a 413", async () => {
    // A stream that yields one small chunk and then faults, i.e. the upstream
    // connection dropped mid-body. This must not be reported as "payload too
    // large" or the agent would give up instead of retrying.
    const faultyBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("socket hang up"));
      },
    });
    const handler = makeHandler(async () => new Response(faultyBody, { status: 200 }));

    const result = await handler(baseRequest);

    expect(result.status).toBe(502);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body.code).toBe("bridge_upstream_read_failed");
    expect(body.error).toContain("socket hang up");
    expect(body.upstreamStatus).toBe(200);
  });

  it("maps a fetch timeout to a 504 with the ambiguous-outcome warning", async () => {
    const handler = makeHandler(async () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    });

    const result = await handler({ ...baseRequest, method: "POST", body: '{"mutate":true}' });

    expect(result.status).toBe(504);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body.code).toBe("bridge_upstream_timeout");
    expect(body.error).toContain("may or may not have been applied");
  });

  it("maps other fetch rejections to a 502 unreachable error", async () => {
    const handler = makeHandler(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9");
    });

    const result = await handler(baseRequest);

    expect(result.status).toBe(502);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body.code).toBe("bridge_upstream_unreachable");
    expect(body.error).toContain("ECONNREFUSED");
  });

  it("exposes a typed size-limit error so only that failure maps to 413", () => {
    const error = new BridgeResponseBodyTooLargeError(64);
    expect(error.code).toBe("BODY_TOO_LARGE");
    expect(error.message).toContain("64 bytes");
    expect(error).toBeInstanceOf(Error);
  });
});
