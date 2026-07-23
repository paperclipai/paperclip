import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

// Mirrors the mocking pattern in test.probe.test.ts (the CLI lane's
// equivalent suite): mock the execution-target module's process-spawning
// primitives so the live credential probe added to the ACP lane
// (testClaudeAcpEnvironment -> runClaudeAcpCredentialProbe ->
// runClaudeCredentialHelloProbe) never actually shells out, while every
// other execution-target helper keeps its real implementation.
const { ensureAdapterExecutionTargetCommandResolvable, runAdapterExecutionTargetProcess, probeResult, commandResolvable } =
  vi.hoisted(() => {
    const probeResult: { value: { exitCode: number; stdout: string; stderr: string } } = {
      value: { exitCode: 0, stdout: "", stderr: "" },
    };
    const commandResolvable: { value: boolean } = { value: true };
    return {
      probeResult,
      commandResolvable,
      // Command-aware: only the live probe's own `claude` CLI resolvability
      // check is toggled by commandResolvable, the pre-existing ACP-server
      // command check (`agentCommand`, e.g. claude-agent-acp) must keep
      // resolving so these tests exercise ONLY the new probe-gating logic,
      // not an unrelated pre-existing check.
      ensureAdapterExecutionTargetCommandResolvable: vi.fn(async (command: string) => {
        if (!commandResolvable.value && command === "claude") {
          throw new Error("command not found on PATH: claude");
        }
      }),
      runAdapterExecutionTargetProcess: vi.fn(async () => ({
        exitCode: probeResult.value.exitCode,
        signal: null,
        timedOut: false,
        stdout: probeResult.value.stdout,
        stderr: probeResult.value.stderr,
        pid: 123,
        startedAt: new Date().toISOString(),
      })),
    };
  });

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    runAdapterExecutionTargetProcess,
  };
});

import { testClaudeAcpEnvironment } from "./acp.js";

const sandboxTarget: AdapterExecutionTarget = {
  kind: "remote",
  transport: "sandbox",
  providerKey: "daytona",
  remoteCwd: "/home/daytona/paperclip-workspace",
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

const initLine =
  '{"type":"system","subtype":"init","cwd":"/home/daytona/paperclip-workspace","session_id":"abc","tools":["Bash","Read"]}';

// Guard against a real ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN leaking in
// from the host shell (a real risk in an agentic dev environment) making
// the "no credential configured" test non-deterministic.
const HOST_CRED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "ANTHROPIC_BEDROCK_BASE_URL",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of HOST_CRED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  vi.clearAllMocks();
  probeResult.value = { exitCode: 0, stdout: "", stderr: "" };
  commandResolvable.value = true;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Claude ACP lane live credential probe", () => {
  it("hard-fails a rejected credential via the shared CLI hello probe (authFailure set)", async () => {
    probeResult.value = {
      exitCode: 1,
      stdout: initLine,
      stderr: "Invalid API key · Please run /login",
    };

    const result = await testClaudeAcpEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        engine: "acp",
        agentCommand: "/opt/claude-agent-acp",
        command: "claude",
        env: { ANTHROPIC_API_KEY: "sk-ant-api03-invalid" },
      },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.status).toBe("fail");
    const rejected = result.checks.find(
      (check) => check.code === "claude_hello_probe_credential_rejected",
    );
    expect(rejected).toBeTruthy();
    expect(rejected?.level).toBe("error");
    expect(rejected?.authFailure).toBe(true);
  });

  it("passes a valid credential through the same live probe", async () => {
    probeResult.value = {
      exitCode: 0,
      stdout: [
        initLine,
        '{"type":"result","subtype":"success","is_error":false,"result":"hello","session_id":"abc"}',
      ].join("\n"),
      stderr: "",
    };

    const result = await testClaudeAcpEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        engine: "acp",
        agentCommand: "/opt/claude-agent-acp",
        command: "claude",
        env: { ANTHROPIC_API_KEY: "sk-ant-api03-valid" },
      },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    const passed = result.checks.find((check) => check.code === "claude_hello_probe_passed");
    expect(passed).toBeTruthy();
    expect(passed?.level).toBe("info");
    expect(passed?.authFailure).toBeUndefined();
  });

  it("stays permissive (warn, not a hard fail) when the claude CLI binary is not resolvable for the probe", async () => {
    commandResolvable.value = false;

    const result = await testClaudeAcpEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        engine: "acp",
        agentCommand: "/opt/claude-agent-acp",
        command: "claude",
        env: { ANTHROPIC_API_KEY: "sk-ant-api03-something" },
      },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.status).toBe("warn");
    const unavailable = result.checks.find(
      (check) => check.code === "claude_acp_credential_probe_unavailable",
    );
    expect(unavailable).toBeTruthy();
    expect(unavailable?.level).toBe("warn");
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("never claims a rejection when the probe itself throws an unexpected infra error", async () => {
    runAdapterExecutionTargetProcess.mockRejectedValueOnce(new Error("ECONNRESET"));

    const result = await testClaudeAcpEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        engine: "acp",
        agentCommand: "/opt/claude-agent-acp",
        command: "claude",
        env: { ANTHROPIC_API_KEY: "sk-ant-api03-something" },
      },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.status).not.toBe("fail");
    const failed = result.checks.find((check) => check.code === "claude_acp_credential_probe_failed");
    expect(failed).toBeTruthy();
    expect(failed?.level).toBe("warn");
    expect(result.checks.some((check) => check.authFailure)).toBe(false);
  });

  it("does not run the live probe at all when no credential is configured (subscription mode)", async () => {
    const result = await testClaudeAcpEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        engine: "acp",
        agentCommand: "/opt/claude-agent-acp",
        command: "claude",
      },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
    expect(result.checks.some((check) => check.code.startsWith("claude_hello_probe_"))).toBe(false);
    expect(
      result.checks.some((check) => check.code === "claude_acp_credential_probe_unavailable"),
    ).toBe(false);
  });
});
