import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetDirectory,
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  runAdapterExecutionTargetProcess,
  resolveAdapterExecutionTargetCwd,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
  maybeRunSandboxInstallCommand: vi.fn(async () => null),
  runAdapterExecutionTargetProcess: vi.fn(),
  resolveAdapterExecutionTargetCwd: vi.fn((_target, configuredCwd, fallbackCwd) => {
    if (typeof configuredCwd === "string" && configuredCwd.trim().length > 0) return configuredCwd;
    return fallbackCwd;
  }),
}));

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
    resolveAdapterExecutionTargetCwd,
  };
});

import { testEnvironment } from "./test.js";

describe("codex local environment probe auth", () => {
  const cleanupDirs: string[] = [];

  beforeEach(() => {
    runAdapterExecutionTargetProcess.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}",
        "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hello\"}}",
        "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,\"cached_input_tokens\":0,\"output_tokens\":1}}",
      ].join("\n"),
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeFixture(options: { hostAuth?: boolean } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-probe-auth-"));
    cleanupDirs.push(root);

    const paperclipHome = path.join(root, "paperclip-home");
    const sharedCodexHome = path.join(root, "host-codex-home");
    const workspaceDir = path.join(root, "workspace");
    const managedAgentHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "codex-home",
    );

    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    if (options.hostAuth !== false) {
      await fs.writeFile(
        path.join(sharedCodexHome, "auth.json"),
        JSON.stringify({ accessToken: "host-access-token", accountId: "acct-1" }),
        "utf8",
      );
      await fs.writeFile(path.join(sharedCodexHome, "config.toml"), "model = \"gpt-5.5\"\n", "utf8");
    }

    vi.stubEnv("PAPERCLIP_HOME", paperclipHome);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("CODEX_HOME", sharedCodexHome);
    vi.stubEnv("OPENAI_API_KEY", "");

    return { root, paperclipHome, sharedCodexHome, workspaceDir, managedAgentHome };
  }

  it("symlinks host Codex login into an empty managed CODEX_HOME before the local probe", async () => {
    const fx = await makeFixture();

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        command: "codex",
        cwd: fx.workspaceDir,
        env: {
          CODEX_HOME: fx.managedAgentHome,
          OPENAI_API_KEY: "",
        },
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks.some((check) => check.code === "codex_probe_auth_seeded_from_host_login")).toBe(true);
    expect(result.checks.some((check) => check.code === "codex_native_auth_present")).toBe(true);

    const agentAuth = path.join(fx.managedAgentHome, "auth.json");
    expect((await fs.lstat(agentAuth)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await fs.readFile(agentAuth, "utf8"))).toEqual({
      accessToken: "host-access-token",
      accountId: "acct-1",
    });
    await expect(fs.readFile(path.join(fx.managedAgentHome, "config.toml"), "utf8")).resolves.toBe(
      "model = \"gpt-5.5\"\n",
    );

    const probeCall = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, unknown, string, string[], { env: Record<string, string> }]
      | undefined;
    expect(probeCall?.[4].env.CODEX_HOME).toBe(fx.managedAgentHome);
  });

  it("keeps probe token refreshes on the host login through the auth symlink", async () => {
    const fx = await makeFixture();
    const hostAuth = path.join(fx.sharedCodexHome, "auth.json");
    runAdapterExecutionTargetProcess.mockImplementationOnce(async (_runId, _target, _command, _args, options) => {
      await fs.writeFile(
        path.join(options.env.CODEX_HOME, "auth.json"),
        JSON.stringify({ accessToken: "rotated-by-probe", accountId: "acct-1" }),
        "utf8",
      );
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}",
          "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hello\"}}",
          "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,\"cached_input_tokens\":0,\"output_tokens\":1}}",
        ].join("\n"),
        stderr: "",
        pid: 123,
        startedAt: new Date().toISOString(),
      };
    });

    await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        command: "codex",
        cwd: fx.workspaceDir,
        env: {
          CODEX_HOME: fx.managedAgentHome,
          OPENAI_API_KEY: "",
        },
      },
    });

    const agentAuth = path.join(fx.managedAgentHome, "auth.json");
    expect((await fs.lstat(agentAuth)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(agentAuth)).toBe(await fs.realpath(hostAuth));
    expect(JSON.parse(await fs.readFile(hostAuth, "utf8"))).toEqual({
      accessToken: "rotated-by-probe",
      accountId: "acct-1",
    });
  });

  it("keeps the API-key probe path isolated from the managed CODEX_HOME", async () => {
    const fx = await makeFixture();

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        command: "codex",
        cwd: fx.workspaceDir,
        env: {
          CODEX_HOME: fx.managedAgentHome,
          OPENAI_API_KEY: "sk-test",
        },
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks.some((check) => check.code === "codex_probe_auth_seeded_from_host_login")).toBe(false);
    await expect(fs.access(path.join(fx.managedAgentHome, "auth.json"))).rejects.toBeTruthy();

    const probeCall = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, unknown, string, string[], { env: Record<string, string> }]
      | undefined;
    expect(probeCall?.[2]).toBe("sh");
    expect(probeCall?.[4].env.CODEX_HOME).toContain("paperclip-codex-probe-codex-envtest-");
    expect(JSON.parse(probeCall?.[4].env._PAPERCLIP_CODEX_AUTH_JSON ?? "{}")).toEqual({
      OPENAI_API_KEY: "sk-test",
    });
  });

  it("keeps the auth-required hint when no API key or host login exists", async () => {
    const fx = await makeFixture({ hostAuth: false });
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "401 Unauthorized: Missing bearer",
      pid: 123,
      startedAt: new Date().toISOString(),
    });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        command: "codex",
        cwd: fx.workspaceDir,
        env: {
          CODEX_HOME: fx.managedAgentHome,
          OPENAI_API_KEY: "",
        },
      },
    });

    const authCheck = result.checks.find((check) => check.code === "codex_hello_probe_auth_required");
    expect(result.status).toBe("warn");
    expect(authCheck?.hint).toContain("run `codex login` on the host first");
    await expect(fs.access(path.join(fx.managedAgentHome, "auth.json"))).rejects.toBeTruthy();
  });
});
