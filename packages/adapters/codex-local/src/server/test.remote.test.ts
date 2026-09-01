import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

const {
  ensureAdapterExecutionTargetDirectory,
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  prepareManagedCodexHome,
} = vi.hoisted(() => {
  return {
    ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    maybeRunSandboxInstallCommand: vi.fn(async () => null),
    runAdapterExecutionTargetProcess: vi.fn(async (..._args: unknown[]) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}",
        "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Hello.\"}}",
        "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,\"cached_input_tokens\":0,\"output_tokens\":1}}",
      ].join("\n"),
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    })),
    describeAdapterExecutionTarget: vi.fn(() => "QA SSH"),
    resolveAdapterExecutionTargetCwd: vi.fn((target, configuredCwd, fallbackCwd) => {
      if (typeof configuredCwd === "string" && configuredCwd.trim().length > 0) return configuredCwd;
      if (target && typeof target === "object" && "remoteCwd" in target && typeof target.remoteCwd === "string") {
        return target.remoteCwd;
      }
      return fallbackCwd;
    }),
    prepareManagedCodexHome: vi.fn(async () => {
      // Return a real managed home seeded with credentials. The probe may read
      // auth.json, but it must never forward secret-bearing config.toml.
      const dir = await fs.mkdtemp(`${os.tmpdir()}/paperclip-managed-codex-home-`);
      await fs.writeFile(`${dir}/auth.json`, JSON.stringify({ OPENAI_API_KEY: "sk-managed" }));
      await fs.writeFile(`${dir}/config.toml`, "model = \"gpt-5\"\n");
      return dir;
    }),
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetDirectory,
    ensureAdapterExecutionTargetCommandResolvable,
    maybeRunSandboxInstallCommand,
    runAdapterExecutionTargetProcess,
    describeAdapterExecutionTarget,
    resolveAdapterExecutionTargetCwd,
  };
});

vi.mock("./codex-home.js", async () => {
  const actual = await vi.importActual<typeof import("./codex-home.js")>("./codex-home.js");
  return {
    ...actual,
    prepareManagedCodexHome,
  };
});

import { testEnvironment } from "./test.js";

type ExecutionProcessCall = [
  string,
  AdapterExecutionTarget | null,
  string,
  string[],
  {
    cwd: string;
    env: Record<string, string>;
    stdin?: string;
    denyEnvironmentKeys?: readonly string[];
  },
];

function executionProcessCalls(): ExecutionProcessCall[] {
  return runAdapterExecutionTargetProcess.mock.calls as unknown as ExecutionProcessCall[];
}

function buildSandboxTarget(): AdapterExecutionTarget {
  return {
    kind: "remote",
    transport: "sandbox",
    providerKey: "fixture",
    remoteCwd: "/remote/workspace",
    runner: {
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      }),
    },
  };
}

function subscriptionAuthJson(accountId: string, lastRefresh: string, marker: string): string {
  return JSON.stringify({
    tokens: {
      id_token: `id-${marker}`,
      access_token: `access-${marker}`,
      refresh_token: `refresh-${marker}`,
      account_id: accountId,
    },
    last_refresh: lastRefresh,
  });
}

describe("codex remote environment diagnostics", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    delete process.env.CODEX_AUTH_JSON;
    delete process.env._PAPERCLIP_CODEX_AUTH_JSON;
  });

  it("stages native auth only through stdin and keeps it out of argv and child env", async () => {
    const remoteTarget: AdapterExecutionTarget = {
      kind: "remote",
      transport: "ssh",
      remoteCwd: "/remote/workspace",
      spec: {
        host: "127.0.0.1",
        port: 22,
        username: "agent",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        remoteCwd: "/remote/workspace",
        remoteWorkspacePath: "/remote/workspace",
        strictHostKeyChecking: false,
      },
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        engine: "cli",
        command: "codex",
      },
      executionTarget: remoteTarget,
      environmentName: "QA SSH",
    });

    expect(result.status).toBe("pass");
    expect(result.checks.some((check) => check.code === "codex_hello_probe_passed")).toBe(true);
    expect(prepareManagedCodexHome).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(3);
    const probeCall = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, { kind: string; remoteCwd: string }, string, string[], {
          cwd: string;
          env: Record<string, string>;
          stdin?: string;
        }]
      | undefined;
    expect(probeCall?.[1]).toMatchObject({
      kind: "remote",
      remoteCwd: "/remote/workspace",
    });
    expect(probeCall?.[4]).toMatchObject({
      cwd: "/remote/workspace",
      env: expect.objectContaining({ CODEX_HOME: expect.stringMatching(/^\/tmp\/paperclip-codex-probe-/) }),
    });
    const nativeStdin = JSON.parse(probeCall?.[4].stdin ?? "{}") as { authJson?: string };
    expect(nativeStdin).not.toHaveProperty("configToml");
    expect(Buffer.from(nativeStdin.authJson ?? "", "base64").toString("utf8")).toContain(
      "sk-managed",
    );
    expect(JSON.stringify([probeCall?.[2], probeCall?.[3], probeCall?.[4].env])).not.toContain(
      "sk-managed",
    );
    expect(probeCall?.[4].env.OPENAI_API_KEY).toBeUndefined();
    expect(probeCall?.[4].env.CODEX_AUTH_JSON).toBeUndefined();
    expect(probeCall?.[4].env._PAPERCLIP_CODEX_AUTH_JSON).toBeUndefined();

    const cleanupRoot = path.posix.dirname(probeCall?.[4].env.CODEX_HOME ?? "");
    const removeCall = executionProcessCalls()[1];
    const verifyCall = executionProcessCalls()[2];
    expect(removeCall?.[2]).toBe("rm");
    expect(removeCall?.[3]).toEqual(["-rf", "--", cleanupRoot]);
    expect(verifyCall?.[2]).toBe("sh");
    expect(verifyCall?.[3]).toEqual([
      "-c",
      '[ ! -e "$1" ] && [ ! -L "$1" ]',
      "sh",
      cleanupRoot,
    ]);
  });

  it("stages a remote API key only through stdin and verifies auth-root removal", async () => {
    const remoteTarget: AdapterExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "cloudflare",
      remoteCwd: "/remote/workspace",
      runner: {
        execute: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        }),
      },
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        engine: "cli",
        command: "codex",
        search: true,
        dangerouslyBypassApprovalsAndSandbox: true,
        extraArgs: ["--dangerously-bypass-approvals-and-sandbox", "--search", "unsafe-marker"],
        env: {
          OPENAI_API_KEY: "sk-test",
        },
      },
      executionTarget: remoteTarget,
      environmentName: "QA Cloudflare",
    });

    expect(result.status).toBe("pass");
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(3);
    const probeCall = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, AdapterExecutionTarget, string, string[], {
          cwd: string;
          env: Record<string, string>;
          stdin?: string;
        }]
      | undefined;
    expect(probeCall?.[4].env.CODEX_HOME).toMatch(/^\/tmp\/paperclip-codex-probe-/);
    const apiKeyStdin = JSON.parse(probeCall?.[4].stdin ?? "{}") as { authJson?: string };
    expect(apiKeyStdin).not.toHaveProperty("configToml");
    expect(Buffer.from(apiKeyStdin.authJson ?? "", "base64").toString("utf8")).toContain(
      "sk-test",
    );
    expect(JSON.stringify([probeCall?.[2], probeCall?.[3], probeCall?.[4].env])).not.toContain(
      "sk-test",
    );
    expect(probeCall?.[4].env.OPENAI_API_KEY).toBeUndefined();
    expect(probeCall?.[4].env.CODEX_AUTH_JSON).toBeUndefined();
    expect(probeCall?.[4].env._PAPERCLIP_CODEX_AUTH_JSON).toBeUndefined();
    const installCalls = maybeRunSandboxInstallCommand.mock.calls as unknown as Array<[
      { env?: Record<string, string> },
    ]>;
    const installEnv = installCalls[0]?.[0].env;
    expect(installEnv?.OPENAI_API_KEY).toBeUndefined();
    expect(installEnv?.CODEX_AUTH_JSON).toBeUndefined();
    expect(installEnv?._PAPERCLIP_CODEX_AUTH_JSON).toBeUndefined();
    const resolvableCalls = ensureAdapterExecutionTargetCommandResolvable.mock.calls as unknown as Array<[
      string,
      AdapterExecutionTarget | null,
      string,
      Record<string, string>,
    ]>;
    const resolvableEnv = resolvableCalls[0]?.[3];
    expect(resolvableEnv?.OPENAI_API_KEY).toBeUndefined();
    expect(resolvableEnv?.CODEX_AUTH_JSON).toBeUndefined();
    expect(resolvableEnv?._PAPERCLIP_CODEX_AUTH_JSON).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("sk-test");
    expect(probeCall?.[3]).toContain("--skip-git-repo-check");
    expect(probeCall?.[3]).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(probeCall?.[3]).not.toContain("--search");
    expect(probeCall?.[3]).not.toContain("unsafe-marker");

    const cleanupRoot = path.posix.dirname(probeCall?.[4].env.CODEX_HOME ?? "");
    expect(executionProcessCalls()[1]?.[3]).toEqual([
      "-rf",
      "--",
      cleanupRoot,
    ]);
    expect(executionProcessCalls()[2]?.[3]).toEqual([
      "-c",
      '[ ! -e "$1" ] && [ ! -L "$1" ]',
      "sh",
      cleanupRoot,
    ]);
  });

  it("rejects a sandbox subscription probe before execution even when sync-out exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-cli-rotation-"));
    const managedHome = path.join(root, "managed-home");
    const managedAuthPath = path.join(managedHome, "auth.json");
    const older = subscriptionAuthJson("acct-cli", "2026-01-01T00:00:00Z", "older");
    await fs.mkdir(managedHome, { recursive: true });
    await fs.writeFile(managedAuthPath, older, { mode: 0o600 });
    prepareManagedCodexHome.mockResolvedValueOnce(managedHome);
    const target = buildSandboxTarget() as Extract<AdapterExecutionTarget, { transport: "sandbox" }>;
    target.runner = {
      ...target.runner!,
      syncOut: vi.fn(async () => ({ operations: [] })),
    };

    try {
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: { engine: "cli", command: "codex" },
        executionTarget: target,
        environmentName: "Rotation sandbox",
      });

      expect(result.checks).toContainEqual(
        expect.objectContaining({ code: "codex_hello_probe_failed", level: "error" }),
      );
      expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
      expect(target.runner.syncOut).not.toHaveBeenCalled();
      expect(await fs.readFile(managedAuthPath, "utf8")).toBe(older);
      expect((await fs.stat(managedAuthPath)).mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for inline and sandbox subscription auth", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-cli-copyback-fail-"));
    const managedHome = path.join(root, "managed-home");
    const managedAuthPath = path.join(managedHome, "auth.json");
    const authJson = subscriptionAuthJson("acct-cli-fail", "2026-01-01T00:00:00Z", "secret-marker");
    await fs.mkdir(managedHome, { recursive: true });
    await fs.writeFile(managedAuthPath, authJson, { mode: 0o600 });

    try {
      const configured = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: {
          engine: "cli",
          command: "codex",
          env: { CODEX_AUTH_JSON: authJson },
        },
        executionTarget: null,
      });
      expect(configured.checks).toContainEqual(
        expect.objectContaining({ code: "codex_hello_probe_failed", level: "error" }),
      );

      prepareManagedCodexHome.mockResolvedValueOnce(managedHome);
      const target = buildSandboxTarget() as Extract<AdapterExecutionTarget, { transport: "sandbox" }>;
      const remote = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: { engine: "cli", command: "codex" },
        executionTarget: target,
        environmentName: "No copy-back sandbox",
      });
      expect(remote.checks).toContainEqual(
        expect.objectContaining({ code: "codex_hello_probe_failed", level: "error" }),
      );
      expect(JSON.stringify([configured, remote])).not.toMatch(/secret-marker|acct-cli-fail/);
      expect(await fs.readFile(managedAuthPath, "utf8")).toBe(authJson);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prefers configured auth JSON and keeps it out of argv and child env", async () => {
    const authJson = JSON.stringify({ OPENAI_API_KEY: "sk-json-secret" });
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        engine: "cli",
        command: "codex",
        env: {
          CODEX_AUTH_JSON: authJson,
          OPENAI_API_KEY: "sk-lower-priority",
        },
      },
      executionTarget: buildSandboxTarget(),
      environmentName: "QA sandbox",
    });

    expect(result.status).toBe("pass");
    const probeCall = executionProcessCalls()[0];
    const payload = JSON.parse(probeCall?.[4].stdin ?? "{}") as { authJson?: string };
    expect(Buffer.from(payload.authJson ?? "", "base64").toString("utf8")).toBe(authJson);
    expect(JSON.stringify([probeCall?.[2], probeCall?.[3], probeCall?.[4].env])).not.toMatch(
      /sk-json-secret|sk-lower-priority/,
    );
    expect(probeCall?.[4].env.CODEX_AUTH_JSON).toBeUndefined();
    expect(probeCall?.[4].env.OPENAI_API_KEY).toBeUndefined();
    expect(prepareManagedCodexHome).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/sk-json-secret|sk-lower-priority/);
  });

  it("removes and verifies the remote auth root after a killed probe", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: null,
      signal: "SIGKILL",
      timedOut: true,
      stdout: "",
      stderr: "",
      pid: 321,
      startedAt: new Date().toISOString(),
    } as never);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        engine: "cli",
        command: "codex",
        env: { OPENAI_API_KEY: "sk-timeout" },
      },
      executionTarget: buildSandboxTarget(),
      environmentName: "QA sandbox",
    });

    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: "codex_hello_probe_timed_out", level: "warn" }),
    );
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(3);
    const authRoot = path.posix.dirname(
      executionProcessCalls()[0]?.[4].env.CODEX_HOME ?? "",
    );
    expect(executionProcessCalls()[1]?.[3]).toEqual([
      "-rf",
      "--",
      authRoot,
    ]);
    expect(executionProcessCalls()[2]?.[3]).toEqual([
      "-c",
      '[ ! -e "$1" ] && [ ! -L "$1" ]',
      "sh",
      authRoot,
    ]);
    expect(JSON.stringify(result)).not.toContain("sk-timeout");
  });

  it("emits the canonical adapter_auth_missing check when a sandbox hello probe reports missing auth", async () => {
    // The sandbox has no seedable credentials, so the hello probe returns an
    // authentication-required error. The Test must emit the neutral canonical
    // check code. The user interface reads this code to decide login
    // eligibility; it does not parse the message text or the top-level status.
    prepareManagedCodexHome.mockImplementationOnce(async () => {
      const dir = await fs.mkdtemp(`${os.tmpdir()}/paperclip-managed-codex-home-noauth-`);
      await fs.writeFile(`${dir}/config.toml`, "model = \"gpt-5\"\n");
      return dir;
    });
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Not logged in. Please run `codex login` to authenticate.",
      pid: 321,
      startedAt: new Date().toISOString(),
    });

    const remoteTarget: AdapterExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd: "/remote/workspace",
      runner: {
        execute: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        }),
      },
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: { engine: "cli", command: "codex" },
      executionTarget: remoteTarget,
      environmentName: "QA Daytona",
    });

    // A missing-auth probe is a warning, not a failure, so the environment stays
    // testable and the user interface can offer login.
    expect(result.status).toBe("warn");
    expect(result.checks.some((check) => check.code === "adapter_auth_missing")).toBe(true);
    // The descriptive probe check stays, so existing diagnostics keep working.
    expect(result.checks.some((check) => check.code === "codex_hello_probe_auth_required")).toBe(true);
  });

  it("isolates a remote probe from native auth when the host has no credentials to seed", async () => {
    prepareManagedCodexHome.mockImplementationOnce(async () => {
      const dir = await fs.mkdtemp(`${os.tmpdir()}/paperclip-managed-codex-home-noauth-`);
      // No auth.json — only a config file.
      await fs.writeFile(`${dir}/config.toml`, "model = \"gpt-5\"\n");
      return dir;
    });
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Not logged in. Please run `codex login` to authenticate.",
      pid: 321,
      startedAt: new Date().toISOString(),
    });

    const remoteTarget: AdapterExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd: "/remote/workspace",
      runner: {
        execute: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        }),
      },
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: { engine: "cli", command: "codex" },
      executionTarget: remoteTarget,
      environmentName: "QA Daytona",
    });

    expect(result.status).toBe("warn");
    const probeCall = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, AdapterExecutionTarget, string, string[], {
          cwd: string;
          env: Record<string, string>;
          stdin?: string;
        }]
      | undefined;
    expect(probeCall?.[4].env.CODEX_HOME).toMatch(/^\/tmp\/paperclip-codex-probe-/);
    expect(probeCall?.[4].stdin).toContain('"authJson":null');
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(3);
  });

  it("canonicalizes sandbox installation diagnostics without exposing provider details", async () => {
    const rawEvidence = "sk-install-secret user@example.test /private/install/path";
    maybeRunSandboxInstallCommand.mockResolvedValueOnce({
      code: "codex_install_failed",
      level: "warn",
      message: rawEvidence,
      detail: rawEvidence,
      hint: rawEvidence,
    } as never);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: { engine: "cli", command: "custom-codex-wrapper" },
      executionTarget: buildSandboxTarget(),
      environmentName: "QA sandbox",
    });

    expect(result.status).toBe("warn");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "codex_install_failed",
        message: "Codex installation check needs attention.",
      }),
    );
    expect(JSON.stringify(result)).not.toMatch(/sk-install-secret|example\.test|private\/install/);
  });

  it("requires the real Codex CLI command instead of treating a custom command as proof", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: { engine: "cli", command: "custom-codex-wrapper" },
      executionTarget: buildSandboxTarget(),
      environmentName: "QA sandbox",
    });

    expect(result.status).toBe("warn");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "codex_hello_probe_skipped_custom_command",
        level: "warn",
      }),
    );
    expect(result.checks).not.toContainEqual(
      expect.objectContaining({ code: "codex_hello_probe_passed" }),
    );
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("rejects a configured executable path even when its basename is codex", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: { engine: "cli", command: "/private/custom/bin/codex" },
      executionTarget: buildSandboxTarget(),
      environmentName: "QA sandbox",
    });

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "codex_hello_probe_skipped_custom_command",
        level: "warn",
      }),
    );
    expect(result.checks).not.toContainEqual(
      expect.objectContaining({ code: "codex_hello_probe_passed" }),
    );
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("requires the exact bare lowercase codex command", async () => {
    for (const command of ["codex.cmd", "codex.exe", "CODEX"]) {
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: { engine: "cli", command },
        executionTarget: buildSandboxTarget(),
        environmentName: "QA sandbox",
      });

      expect(result.checks).toContainEqual(
        expect.objectContaining({
          code: "codex_hello_probe_skipped_custom_command",
          level: "warn",
        }),
      );
      expect(result.checks).not.toContainEqual(
        expect.objectContaining({ code: "codex_hello_probe_passed" }),
      );
    }
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("returns only canonical Hello diagnostics for successful CLI output", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        "{\"type\":\"thread.started\",\"thread_id\":\"thread-sensitive\"}",
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Hello." },
        }),
        "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,\"cached_input_tokens\":0,\"output_tokens\":1}}",
      ].join("\n"),
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: { engine: "cli", command: "codex" },
      executionTarget: buildSandboxTarget(),
      environmentName: "QA sandbox",
    });

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "codex_hello_probe_passed",
        level: "info",
        detail: "Hello.",
      }),
    );
    expect(JSON.stringify(result)).not.toContain("thread-sensitive");
  });

  it("requires an explicit successful terminal event with no protocol failure", async () => {
    const rawEvidence = "sk-terminal-secret user@example.test /private/terminal";
    const streams = [
      [
        '{"type":"thread.started","thread_id":"thread-1"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"Hello."}}',
      ].join("\n"),
      [
        '{"type":"item.completed","item":{"type":"agent_message","text":"Hello."}}',
        JSON.stringify({ type: "error", message: rawEvidence }),
        '{"type":"turn.completed","usage":{}}',
      ].join("\n"),
      [
        '{"type":"item.completed","item":{"type":"agent_message","text":"Hello."}}',
        '{"type":"turn.failed","error":{}}',
      ].join("\n"),
      [
        "not-json",
        '{"type":"item.completed","item":{"type":"agent_message","text":"Hello."}}',
        '{"type":"turn.completed","usage":{}}',
      ].join("\n"),
      [
        "[]",
        '{"type":"item.completed","item":{"type":"agent_message","text":"Hello."}}',
        '{"type":"turn.completed","usage":{}}',
      ].join("\n"),
      [
        '{"type":"provider.custom"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"Hello."}}',
        '{"type":"turn.completed","usage":{}}',
      ].join("\n"),
      [
        '{"type":"item.completed"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"Hello."}}',
        '{"type":"turn.completed","usage":{}}',
      ].join("\n"),
      [
        '{"type":"turn.completed","usage":{}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"Hello."}}',
      ].join("\n"),
      [
        '{"type":"item.completed","item":{"type":"agent_message","text":"Hello."}}',
        '{"type":"turn.completed","usage":{}}',
        '{"type":"turn.completed","usage":{}}',
      ].join("\n"),
      [
        '{"type":"item.completed","item":{"type":"agent_message","text":"Hello."}}',
        '{"type":"turn.completed","usage":{}}',
        '{"type":"thread.started","thread_id":"late"}',
      ].join("\n"),
      [
        '{"type":"item.completed","item":{"type":"agent_message","text":"Not hello"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"Hello."}}',
        '{"type":"turn.completed","usage":{}}',
      ].join("\n"),
      [
        '{"type":"thread.started","thread_id":"thread-1"}',
        '{"type":"item.completed","item":{"type":"command_execution","command":"touch sentinel"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"Hello."}}',
        '{"type":"turn.completed","usage":{}}',
      ].join("\n"),
    ];

    for (const stdout of streams) {
      runAdapterExecutionTargetProcess.mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout,
        stderr: rawEvidence,
        pid: 123,
        startedAt: new Date().toISOString(),
      });
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: { engine: "cli", command: "codex" },
        executionTarget: buildSandboxTarget(),
        environmentName: "QA sandbox",
      });

      expect(result.checks).toContainEqual(
        expect.objectContaining({ code: "codex_hello_probe_failed", level: "error" }),
      );
      expect(result.checks).not.toContainEqual(
        expect.objectContaining({ code: "codex_hello_probe_passed" }),
      );
      expect(JSON.stringify(result)).not.toMatch(
        /sk-terminal-secret|example\.test|private\/terminal/,
      );
    }
  });

  it("replaces a successful CLI proof when remote auth-root verification fails", async () => {
    const rawEvidence = "sk-cleanup-secret user@example.test /private/auth-root";
    runAdapterExecutionTargetProcess
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          '{"type":"item.completed","item":{"type":"agent_message","text":"Hello."}}',
          '{"type":"turn.completed","usage":{}}',
        ].join("\n"),
        stderr: "",
        pid: 123,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: 124,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: rawEvidence,
        pid: 125,
        startedAt: new Date().toISOString(),
      });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: { engine: "cli", command: "codex" },
      executionTarget: buildSandboxTarget(),
      environmentName: "QA sandbox",
    });

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "codex_hello_probe_cleanup_failed",
        level: "error",
      }),
    );
    expect(result.checks).not.toContainEqual(
      expect.objectContaining({ code: "codex_hello_probe_passed" }),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /sk-cleanup-secret|example\.test|private\/auth-root/,
    );
  });

  it("canonicalizes preparation failures without exposing raw errors", async () => {
    prepareManagedCodexHome.mockRejectedValueOnce(
      new Error("sk-prepare-secret user@example.test /private/managed-home"),
    );

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: { engine: "cli", command: "codex" },
      executionTarget: buildSandboxTarget(),
      environmentName: "QA sandbox",
    });

    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: "codex_hello_probe_failed", level: "error" }),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /sk-prepare-secret|example\.test|private\/managed-home/,
    );
  });

  it("lets cleanup failure dominate a raw runner rejection", async () => {
    runAdapterExecutionTargetProcess
      .mockRejectedValueOnce(new Error("sk-spawn-secret user@example.test /private/spawn"))
      .mockRejectedValueOnce(new Error("sk-cleanup-secret /private/cleanup"));

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        engine: "cli",
        command: "codex",
        env: { OPENAI_API_KEY: "sk-config-secret" },
      },
      executionTarget: buildSandboxTarget(),
      environmentName: "QA sandbox",
    });

    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: "codex_hello_probe_cleanup_failed", level: "error" }),
    );
    expect(result.checks).not.toContainEqual(
      expect.objectContaining({ code: "codex_hello_probe_passed" }),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /sk-spawn-secret|sk-cleanup-secret|sk-config-secret|example\.test|private\//,
    );
  });

  it("replaces a successful local API-key proof when temp cleanup fails", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const realRm = fs.rm.bind(fs);
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (candidate, options) => {
      if (String(candidate).includes("paperclip-codex-probe-")) {
        throw new Error("sk-temp-secret user@example.test /private/probe-home");
      }
      return realRm(candidate, options);
    });
    try {
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: { engine: "cli", command: "codex" },
        executionTarget: null,
      });

      expect(result.checks).toContainEqual(
        expect.objectContaining({
          code: "codex_hello_probe_cleanup_failed",
          level: "error",
        }),
      );
      expect(result.checks).not.toContainEqual(
        expect.objectContaining({ code: "codex_hello_probe_passed" }),
      );
      expect(JSON.stringify(result)).not.toMatch(
        /sk-temp-secret|example\.test|private\/probe-home/,
      );
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("removes the local probe root when auth staging fails", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const realRm = fs.rm.bind(fs);
    let removedProbeRoot: string | null = null;
    const writeSpy = vi.spyOn(fs, "writeFile").mockRejectedValueOnce(
      new Error("sk-stage-secret user@example.test /private/probe-auth"),
    );
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (candidate, options) => {
      if (String(candidate).includes("paperclip-codex-probe-")) {
        removedProbeRoot = String(candidate);
      }
      return realRm(candidate, options);
    });
    try {
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: { engine: "cli", command: "codex" },
        executionTarget: null,
      });

      expect(result.checks).toContainEqual(
        expect.objectContaining({ code: "codex_hello_probe_failed", level: "error" }),
      );
      expect(result.checks).not.toContainEqual(
        expect.objectContaining({ code: "codex_hello_probe_cleanup_failed" }),
      );
      expect(removedProbeRoot).not.toBeNull();
      expect(await fs.lstat(removedProbeRoot!).catch(() => null)).toBeNull();
      expect(JSON.stringify(result)).not.toMatch(
        /sk-stage-secret|example\.test|private\/probe-auth/,
      );
    } finally {
      writeSpy.mockRestore();
      rmSpy.mockRestore();
    }
  });

  it("reports cleanup failure when failed auth staging leaves a local probe root", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const realRm = fs.rm.bind(fs);
    let abandonedProbeRoot: string | null = null;
    const writeSpy = vi.spyOn(fs, "writeFile").mockRejectedValueOnce(
      new Error("sk-stage-secret user@example.test /private/probe-auth"),
    );
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (candidate, options) => {
      if (String(candidate).includes("paperclip-codex-probe-")) {
        abandonedProbeRoot = String(candidate);
        throw new Error("sk-cleanup-secret user@example.test /private/probe-root");
      }
      return realRm(candidate, options);
    });
    try {
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: { engine: "cli", command: "codex" },
        executionTarget: null,
      });

      expect(result.checks).toContainEqual(
        expect.objectContaining({
          code: "codex_hello_probe_cleanup_failed",
          level: "error",
        }),
      );
      expect(result.checks).not.toContainEqual(
        expect.objectContaining({ code: "codex_hello_probe_passed" }),
      );
      expect(abandonedProbeRoot).not.toBeNull();
      expect(JSON.stringify(result)).not.toMatch(
        /sk-stage-secret|sk-cleanup-secret|example\.test|private\//,
      );
    } finally {
      writeSpy.mockRestore();
      rmSpy.mockRestore();
      if (abandonedProbeRoot) {
        await realRm(abandonedProbeRoot, { recursive: true, force: true });
      }
    }
  });

  it("does not expose unexpected or failed CLI output", async () => {
    const rawEvidence = "sk-failure-secret user@example.test /private/failure/path";
    const probeResults = [
      {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: `Not hello ${rawEvidence}` },
          }),
          '{"type":"turn.completed","usage":{}}',
        ].join("\n"),
        stderr: rawEvidence,
        pid: 123,
        startedAt: new Date().toISOString(),
      },
      {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: `Hello. ${rawEvidence}` },
          }),
          '{"type":"turn.completed","usage":{}}',
        ].join("\n"),
        stderr: rawEvidence,
        pid: 123,
        startedAt: new Date().toISOString(),
      },
      {
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: rawEvidence,
        stderr: rawEvidence,
        pid: 123,
        startedAt: new Date().toISOString(),
      },
    ];

    for (const probeResult of probeResults) {
      runAdapterExecutionTargetProcess.mockResolvedValueOnce(probeResult);
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: { engine: "cli", command: "codex" },
        executionTarget: buildSandboxTarget(),
        environmentName: "QA sandbox",
      });
      expect(result.checks).not.toContainEqual(
        expect.objectContaining({ code: "codex_hello_probe_passed" }),
      );
      expect(JSON.stringify(result)).not.toMatch(/sk-failure-secret|example\.test|private\/failure/);
    }
  });

  it("preserves sandbox files while staging 0600 auth over stdin and cleaning the auth root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-probe-preserve-"));
    const sandboxWorkspace = path.join(root, "sandbox-workspace");
    const sandboxDefaultCwd = path.join(root, "sandbox-default");
    const sandboxBin = path.join(root, "bin");
    const sentinelPath = path.join(sandboxWorkspace, "operator-data.txt");
    await fs.mkdir(sandboxWorkspace, { recursive: true });
    await fs.mkdir(sandboxDefaultCwd, { recursive: true });
    await fs.mkdir(sandboxBin, { recursive: true });
    await fs.writeFile(sentinelPath, "keep-this-byte-for-byte\n", "utf8");
    const fakeCodex = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const forbidden = ["OPENAI_API_KEY", "CODEX_AUTH_JSON", "_PAPERCLIP_CODEX_AUTH_JSON"];
const home = process.env.CODEX_HOME || "";
const authPath = path.join(home, "auth.json");
const prompt = fs.readFileSync(0, "utf8").trim();
const failures = [];
if (!forbidden.every((key) => process.env[key] === undefined)) failures.push("ambient-auth");
if (path.basename(process.cwd()) !== "workspace") failures.push("workspace-name");
if (fs.realpathSync(path.dirname(process.cwd())) !== fs.realpathSync(path.dirname(home))) failures.push("workspace-scope");
if (fs.realpathSync(process.cwd()) === fs.realpathSync(${JSON.stringify(sandboxWorkspace)})) failures.push("operator-workspace");
if (prompt !== "Reply with exactly Hello. Do not use tools.") failures.push("prompt");
try {
  const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  if (typeof auth.OPENAI_API_KEY !== "string") failures.push("auth-shape");
  if ((fs.statSync(authPath).mode & 0o777) !== 0o600) failures.push("auth-mode");
} catch {
  failures.push("auth-read");
}
if (failures.length > 0) {
  process.stdout.write(JSON.stringify({type:"turn.failed",error:{failures}}) + "\\n");
  process.exit(1);
}
process.stdout.write('{"type":"thread.started","thread_id":"thread-1"}\\n');
process.stdout.write('{"type":"item.completed","item":{"type":"reasoning","text":""}}\\n');
process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"Hello."}}\\n');
process.stdout.write('{"type":"turn.completed","usage":{}}\\n');
`;
    await fs.writeFile(path.join(sandboxBin, "codex"), fakeCodex, {
      encoding: "utf8",
      mode: 0o755,
    });

    let observedAuthRoot: string | null = null;
    const observedRuns: Array<Awaited<ReturnType<typeof runChildProcess>>> = [];
    const runner = {
      execute: async (input: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        stdin?: string;
        timeoutMs?: number;
        onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      }) => {
        const command = input.command === "bash" ? "/bin/bash" : input.command;
        if (input.env?.CODEX_HOME) observedAuthRoot = input.env.CODEX_HOME;
        const inheritedEnv = Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            typeof entry[1] === "string"
          ),
        );
        const result = await runChildProcess("codex-probe-preserve", command, input.args ?? [], {
          cwd: input.cwd ?? "/",
          env: {
            ...inheritedEnv,
            ...input.env,
            PATH: `${sandboxBin}:${inheritedEnv.PATH ?? ""}`,
          },
          stdin: input.stdin,
          timeoutSec: Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000)),
          graceSec: 5,
          onLog: input.onLog ?? (async () => {}),
        });
        observedRuns.push(result);
        return result;
      },
    };
    const target: AdapterExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-behavioral-fixture",
      remoteCwd: sandboxDefaultCwd,
      runner,
    };
    const actualExecutionTarget = await vi.importActual<
      typeof import("@paperclipai/adapter-utils/execution-target")
    >("@paperclipai/adapter-utils/execution-target");
    runAdapterExecutionTargetProcess.mockImplementation(
      actualExecutionTarget.runAdapterExecutionTargetProcess as never,
    );

    try {
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: {
          engine: "cli",
          command: "codex",
          cwd: sandboxWorkspace,
          env: { OPENAI_API_KEY: "sk-behavioral" },
        },
        executionTarget: target,
        environmentName: "Behavioral sandbox",
      });

      expect(observedRuns[0]?.stderr).toBe("");
      expect(observedRuns[0]?.stdout).toContain('"type":"turn.completed"');
      expect(result.checks).toContainEqual(
        expect.objectContaining({ code: "codex_hello_probe_passed", level: "info" }),
      );
      expect(observedAuthRoot).toMatch(/^\/tmp\/paperclip-codex-probe-/);
      await expect(fs.stat(observedAuthRoot!).catch(() => null)).resolves.toBeNull();
      await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe(
        "keep-this-byte-for-byte\n",
      );
      await expect(fs.readdir(sandboxWorkspace)).resolves.toEqual(["operator-data.txt"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("omits host Codex secrets from the real local child environment", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-local-env-"));
    const binDir = path.join(root, "bin");
    await fs.mkdir(binDir, { recursive: true });
    const fakeCodex = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const forbidden = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_AUTH_JSON", "_PAPERCLIP_CODEX_AUTH_JSON"];
const home = process.env.CODEX_HOME || "";
const prompt = fs.readFileSync(0, "utf8").trim();
let valid = forbidden.every((key) => process.env[key] === undefined);
valid = valid && prompt === "Reply with exactly Hello. Do not use tools.";
valid = valid && path.basename(process.cwd()) === "workspace";
valid = valid && fs.realpathSync(process.cwd()) !== fs.realpathSync(${JSON.stringify(root)});
try {
  const authPath = path.join(home, "auth.json");
  const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  valid = valid && auth.OPENAI_API_KEY === "sk-host-secret";
  valid = valid && (fs.statSync(authPath).mode & 0o777) === 0o600;
} catch {
  valid = false;
}
if (!valid) {
  process.stdout.write('{"type":"turn.failed","error":{}}\\n');
  process.exit(1);
}
process.stdout.write('{"type":"thread.started","thread_id":"thread-1"}\\n');
process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"Hello."}}\\n');
process.stdout.write('{"type":"turn.completed","usage":{}}\\n');
`;
    await fs.writeFile(path.join(binDir, "codex"), fakeCodex, {
      encoding: "utf8",
      mode: 0o755,
    });

    const originalEnv = {
      PATH: process.env.PATH,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CODEX_API_KEY: process.env.CODEX_API_KEY,
      CODEX_AUTH_JSON: process.env.CODEX_AUTH_JSON,
      _PAPERCLIP_CODEX_AUTH_JSON: process.env._PAPERCLIP_CODEX_AUTH_JSON,
    };
    process.env.PATH = `${binDir}${path.delimiter}${originalEnv.PATH ?? ""}`;
    process.env.OPENAI_API_KEY = "sk-host-secret";
    process.env.CODEX_API_KEY = "sk-host-secondary";
    process.env.CODEX_AUTH_JSON = "sk-host-auth-json";
    process.env._PAPERCLIP_CODEX_AUTH_JSON = "sk-host-paperclip-json";
    const actualExecutionTarget = await vi.importActual<
      typeof import("@paperclipai/adapter-utils/execution-target")
    >("@paperclipai/adapter-utils/execution-target");
    runAdapterExecutionTargetProcess.mockImplementation(
      actualExecutionTarget.runAdapterExecutionTargetProcess as never,
    );

    try {
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: {
          engine: "cli",
          command: "codex",
          cwd: root,
          dangerouslyBypassApprovalsAndSandbox: true,
          extraArgs: ["--dangerously-bypass-approvals-and-sandbox", "unsafe-local-marker"],
        },
        executionTarget: null,
      });

      expect(result.checks).toContainEqual(
        expect.objectContaining({ code: "codex_hello_probe_passed", level: "info" }),
      );
      const probeCall = executionProcessCalls()[0];
      expect(probeCall?.[4].cwd).not.toBe(root);
      expect(path.basename(probeCall?.[4].cwd ?? "")).toBe("workspace");
      expect(probeCall?.[3]).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(probeCall?.[3]).not.toContain("unsafe-local-marker");
      expect(probeCall?.[4].denyEnvironmentKeys).toEqual([
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "CODEX_AUTH_JSON",
        "_PAPERCLIP_CODEX_AUTH_JSON",
      ]);
      const authRoot = probeCall?.[4].env.CODEX_HOME;
      await expect(fs.lstat(authRoot!).catch(() => null)).resolves.toBeNull();
      expect(JSON.stringify(result)).not.toMatch(
        /sk-host-secret|sk-host-secondary|sk-host-auth-json|sk-host-paperclip-json/,
      );
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
