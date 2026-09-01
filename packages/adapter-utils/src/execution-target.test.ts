import { afterEach, describe, expect, it, vi } from "vitest";
import * as ssh from "./ssh.js";
import * as serverUtils from "./server-utils.js";
import {
  adapterExecutionTargetUsesManagedHome,
  buildPostProfileEnvironmentScrubShell,
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
        omitInheritedEnvKeys: ["OPENAI_API_KEY"],
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
        omitInheritedEnvKeys: ["OPENAI_API_KEY"],
      }),
    );
  });

  it("preserves explicit remote configuration when only inherited keys are omitted", async () => {
    const runner = {
      execute: vi.fn(async (input: {
        command: string;
        args?: string[];
        cwd: string;
        env?: Record<string, string>;
      }) => serverUtils.runChildProcess(
        "explicit-remote-env",
        input.command,
        input.args ?? [],
        {
          cwd: input.cwd,
          env: input.env ?? {},
          omitInheritedEnvKeys: Object.keys(process.env),
          timeoutSec: 5,
          graceSec: 1,
          onLog: async () => {},
        },
      )),
    };

    const result = await runAdapterExecutionTargetProcess(
      "explicit-remote-env",
      {
        kind: "remote",
        transport: "sandbox",
        providerKey: "fake-plugin",
        remoteCwd: "/tmp",
        runner,
      },
      process.execPath,
      ["-e", "process.stdout.write(process.env.OPENAI_API_KEY ?? 'missing')"],
      {
        cwd: "/tmp",
        env: { OPENAI_API_KEY: "explicit-config-secret" },
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
        omitInheritedEnvKeys: ["OPENAI_API_KEY"],
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("explicit-config-secret");
    expect(runner.execute.mock.calls[0]?.[0].command).toBe(process.execPath);
  });

  it("denies env names case-insensitively after sandbox profile injection", async () => {
    const profileEnv = {
      openai_api_key: "profile-openai-secret",
      CoDeX_ApI_Key: "profile-codex-secret",
      codex_AUTH_json: "profile-auth-json-secret",
      _paperclip_codex_auth_json: "profile-paperclip-auth-secret",
    };
    const runner = {
      execute: vi.fn(async (input: {
        command: string;
        args?: string[];
        cwd: string;
        env?: Record<string, string>;
        stdin?: string;
      }) => serverUtils.runChildProcess(
        "profile-simulated-sandbox",
        input.command,
        input.args ?? [],
        {
          cwd: input.cwd,
          env: { ...(input.env ?? {}), ...profileEnv, SAFE_VALUE: "visible" },
          omitInheritedEnvKeys: Object.keys(process.env),
          stdin: input.stdin,
          timeoutSec: 5,
          graceSec: 1,
          onLog: async () => {},
        },
      )),
    };

    const result = await runAdapterExecutionTargetProcess(
      "profile-simulated-sandbox",
      {
        kind: "remote",
        transport: "sandbox",
        providerKey: "fake-plugin",
        remoteCwd: "/tmp",
        runner,
      },
      "env",
      [],
      {
        cwd: "/tmp",
        env: {},
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
        denyEnvironmentKeys: [
          "OPENAI_API_KEY",
          "CODEX_API_KEY",
          "CODEX_AUTH_JSON",
          "_PAPERCLIP_CODEX_AUTH_JSON",
        ],
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("SAFE_VALUE=visible");
    for (const [key, secret] of Object.entries(profileEnv)) {
      expect(result.stdout).not.toContain(`${key}=`);
      expect(result.stdout).not.toContain(secret);
    }
    const launch = runner.execute.mock.calls[0]?.[0];
    expect(launch?.command).toBe("sh");
    expect(launch?.args?.join(" ")).not.toContain("profile-openai-secret");
  });

  it("keeps the post-profile scrub inside a sandbox run-log wrapper", async () => {
    const wrapCommand = vi.fn((command: string, args: string[]) => ({ command, args }));
    const runner = {
      execute: vi.fn(async (_input: { command: string; args?: string[] }) => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };
    const runLogTail = {
      create: () => ({
        wrapCommand,
        start: () => {},
        finish: async () => {},
        abort: async () => {},
      }),
    };

    await runAdapterExecutionTargetProcess(
      "profile-scrub-with-tail",
      {
        kind: "remote",
        transport: "sandbox",
        providerKey: "fake-plugin",
        remoteCwd: "/tmp",
        runner,
      },
      "agent-cli",
      ["--json"],
      {
        cwd: "/tmp",
        env: {},
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
        denyEnvironmentKeys: ["OPENAI_API_KEY"],
        runLogTail,
      },
    );

    expect(wrapCommand).toHaveBeenCalledOnce();
    const wrapped = wrapCommand.mock.results[0]?.value;
    expect(wrapped?.command).toBe("sh");
    expect(wrapped?.args).toEqual([
      "-c",
      expect.stringMatching(/unset .*paperclip_env_name.*exec 'agent-cli' '--json'/),
    ]);
    expect(runner.execute.mock.calls[0]?.[0]).toMatchObject(wrapped ?? {});
  });

  it("fails closed when the remote scrub cannot enumerate a restricted read-only PATH", async () => {
    const shell = buildPostProfileEnvironmentScrubShell(
      "printf 'TARGET_RAN'",
      ["OPENAI_API_KEY"],
    );
    const result = await serverUtils.runChildProcess(
      "profile-scrub-restricted-path",
      "/bin/sh",
      ["-c", `readonly PATH; export PATH; ${shell}`],
      {
        cwd: "/tmp",
        env: { PATH: "/paperclip/definitely-missing" },
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("TARGET_RAN");
  });

  it("fails closed when a denied environment name is read-only", async () => {
    const scrub = buildPostProfileEnvironmentScrubShell(
      "printf 'TARGET_RAN'",
      ["OPENAI_API_KEY"],
    );
    const result = await serverUtils.runChildProcess(
      "profile-scrub-readonly-key",
      "/bin/sh",
      [
        "-c",
        `OPENAI_API_KEY=profile-secret; readonly OPENAI_API_KEY; export OPENAI_API_KEY; ${scrub}`,
      ],
      {
        cwd: "/tmp",
        env: {},
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("TARGET_RAN");
  });

  it("disables inherited xtrace before environment values are captured", async () => {
    const shell = buildPostProfileEnvironmentScrubShell(
      "/bin/sh -c 'if [ -n \"${OPENAI_API_KEY+x}\" ]; then exit 99; fi; printf \"TARGET_RAN\"'",
      ["OPENAI_API_KEY"],
    );
    const result = await serverUtils.runChildProcess(
      "profile-scrub-xtrace",
      "/bin/sh",
      ["-xc", shell],
      {
        cwd: "/tmp",
        env: {
          OPENAI_API_KEY: "denied-xtrace-secret",
          UNRELATED_SECRET: "ambient-xtrace-secret",
        },
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("TARGET_RAN");
    expect(result.stderr).not.toMatch(/denied-xtrace-secret|ambient-xtrace-secret/);
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
