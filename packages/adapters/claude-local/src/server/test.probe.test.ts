import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const {
  ensureAdapterExecutionTargetDirectory,
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  probeResult,
  claudeCliUnresolvable,
} = vi.hoisted(() => {
  const probeResult: { value: { exitCode: number; stdout: string; stderr: string } } = {
    value: { exitCode: 1, stdout: "", stderr: "" },
  };
  // Command-aware toggle used only by the ACP-pipeline "probe cannot run"
  // test below: the ACP lane calls this resolvability check multiple times
  // for DIFFERENT commands in one testEnvironment() call (engine
  // resolution's own pre-check, testClaudeAcpEnvironment's ACP-server
  // command check, and the new credential probe's `claude` CLI check), a
  // call-order-dependent mock would be fragile, so this rejects ONLY the
  // `claude` binary check specifically when enabled, leaving every other
  // command (including the CLI lane's own default `command: "claude"` in
  // every other test in this file) on the default always-succeeds path.
  const claudeCliUnresolvable: { value: boolean } = { value: false };
  return {
    probeResult,
    claudeCliUnresolvable,
    ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async (command: string) => {
      if (claudeCliUnresolvable.value && command === "claude") {
        throw new Error("command not found on PATH: claude");
      }
    }),
    maybeRunSandboxInstallCommand: vi.fn(async () => null),
    runAdapterExecutionTargetProcess: vi.fn(async () => ({
      exitCode: probeResult.value.exitCode,
      signal: null,
      timedOut: false,
      stdout: probeResult.value.stdout,
      stderr: probeResult.value.stderr,
      pid: 123,
      startedAt: new Date().toISOString(),
    })),
    describeAdapterExecutionTarget: vi.fn(() => "Daytona"),
    resolveAdapterExecutionTargetCwd: vi.fn(() => "/home/daytona/paperclip-workspace"),
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

import { testEnvironment } from "./test.js";

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

afterEach(() => {
  vi.clearAllMocks();
  claudeCliUnresolvable.value = false;
});

describe("claude sandbox hello probe diagnostics", () => {
  it("surfaces the final result error instead of the system/init line on failure", async () => {
    probeResult.value = {
      exitCode: 1,
      stdout: [
        initLine,
        '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: 404 model not found: claude-opus-4-8","session_id":"abc"}',
      ].join("\n"),
      stderr: "",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude", model: "claude-opus-4-8" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.status).toBe("fail");
    const failed = result.checks.find((check) => check.code === "claude_hello_probe_failed");
    expect(failed).toBeTruthy();
    expect(failed?.detail).toContain("404 model not found: claude-opus-4-8");
    // The unhelpful init line must not be what we show the operator.
    expect(failed?.detail).not.toContain('"subtype":"init"');
  });

  it("classifies rate-limit/overload failures as a transient warning, not a hard fail", async () => {
    probeResult.value = {
      exitCode: 1,
      stdout: [
        initLine,
        '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Claude usage limit reached. Please try again later.","session_id":"abc"}',
      ].join("\n"),
      stderr: "",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.checks.some((check) => check.code === "claude_hello_probe_transient_upstream")).toBe(true);
    expect(result.checks.some((check) => check.code === "claude_hello_probe_failed")).toBe(false);
  });

  it("falls back to the last stdout line when no result event is emitted", async () => {
    probeResult.value = {
      exitCode: 1,
      stdout: [initLine, "fatal: claude crashed unexpectedly"].join("\n"),
      stderr: "",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    const failed = result.checks.find((check) => check.code === "claude_hello_probe_failed");
    expect(failed?.detail).toContain("claude crashed unexpectedly");
  });

  it("does not show the system/init event when it is the only stdout line", async () => {
    probeResult.value = {
      exitCode: 1,
      stdout: initLine,
      stderr: "",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    const failed = result.checks.find((check) => check.code === "claude_hello_probe_failed");
    expect(failed?.detail).toBeUndefined();
  });

  it("hard-fails an invalid just-pasted API key instead of the soft 'please log in' nudge", async () => {
    // This is the exact CLI message a just-bound, syntactically-plausible
    // but wrong Anthropic key produces: it happens to mention /login even
    // though the real problem is the key itself, not a missing session.
    probeResult.value = {
      exitCode: 1,
      stdout: initLine,
      stderr: "Invalid API key · Please run /login",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.status).toBe("fail");
    const rejected = result.checks.find((check) => check.code === "claude_hello_probe_credential_rejected");
    expect(rejected).toBeTruthy();
    expect(rejected?.level).toBe("error");
    expect(rejected?.authFailure).toBe(true);
    expect(result.checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(false);
  });

  it("keeps the soft 'login required' warning for a genuine not-signed-in-yet prompt", async () => {
    probeResult.value = {
      exitCode: 1,
      stdout: initLine,
      stderr: "Please log in. Run `claude login` first.",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.status).toBe("warn");
    const authRequired = result.checks.find((check) => check.code === "claude_hello_probe_auth_required");
    expect(authRequired).toBeTruthy();
    expect(authRequired?.authFailure).toBeUndefined();
    expect(result.checks.some((check) => check.code === "claude_hello_probe_credential_rejected")).toBe(false);
  });

  it("flags authFailure on a raw 401/invalid x-api-key failure that never matches the login-prompt wording", async () => {
    probeResult.value = {
      exitCode: 1,
      stdout: initLine,
      stderr:
        'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.status).toBe("fail");
    const failed = result.checks.find((check) => check.code === "claude_hello_probe_failed");
    expect(failed?.authFailure).toBe(true);
  });

  it("does not hard-fail on incidental 'unauthorized' substring noise unrelated to the login prompt", async () => {
    // Pins the tightened CLAUDE_CREDENTIAL_REJECTED_RE at the full pipeline
    // level: requiresLogin still fires (CLAUDE_AUTH_REQUIRED_RE's bare
    // "unauthorized" alternative is unchanged, pre-existing behavior), but
    // credentialRejected must not, so this stays the existing soft "please
    // log in" warning rather than a hard authFailure.
    probeResult.value = {
      exitCode: 1,
      stdout: initLine,
      stderr: "Fetching https://api.example.com/orders?status=unauthorized_pending",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    const authRequired = result.checks.find((check) => check.code === "claude_hello_probe_auth_required");
    expect(authRequired).toBeTruthy();
    expect(authRequired?.authFailure).toBeUndefined();
    expect(result.checks.some((check) => check.code === "claude_hello_probe_credential_rejected")).toBe(
      false,
    );
  });

  it("documents a false negative: an unrecognized rejection wording ('token revoked') still fails overall but without the authFailure flag", async () => {
    // The probe still hard-fails (a real error card shows up in the
    // "Adapter environment check" panel), but because the wording matches
    // none of our credential-rejection patterns, the authFailure-driven
    // gate-closing behavior in OnboardingWizard does not kick in for this
    // specific wording. A known, documented false-negative surface, not a
    // crash, and not silently reported as passing.
    probeResult.value = {
      exitCode: 1,
      stdout: initLine,
      stderr: "Your token has been revoked.",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "cli", command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.status).toBe("fail");
    const failed = result.checks.find((check) => check.code === "claude_hello_probe_failed");
    expect(failed).toBeTruthy();
    expect(failed?.authFailure).toBeUndefined();
  });
});

// Pipeline-level pin for the staging bug: onboarding never sends an
// explicit `engine`, and the default resolves to ACP (see
// resolveClaudeExecutionEngineForRun in acp.ts) whenever the sandbox has a
// bidirectional process target (sandboxTarget, reused from above, has a
// `runner`). Before the ACP lane grew its own live credential probe, this
// exact entrypoint, the one the server route actually calls, could never
// produce an authFailure check for ANY credential, valid or not: it just
// emitted static info/warn checks and said "Passed". These tests exercise
// the real production call path (testEnvironment, no explicit engine) end
// to end, not just the internal testClaudeAcpEnvironment/acp.ts unit level
// (see acp.probe.test.ts for those).
describe("Claude ACP lane via the shared testEnvironment entrypoint (no explicit engine)", () => {
  it("hard-fails a rejected credential end to end through the default ACP path", async () => {
    probeResult.value = {
      exitCode: 1,
      stdout: initLine,
      stderr: "Invalid API key · Please run /login",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { command: "claude", env: { ANTHROPIC_API_KEY: "sk-ant-api03-invalid" } },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.status).toBe("fail");
    const rejected = result.checks.find(
      (check) => check.code === "claude_hello_probe_credential_rejected",
    );
    expect(rejected).toBeTruthy();
    expect(rejected?.authFailure).toBe(true);
    // Sanity check this really took the ACP path, not a CLI fallback.
    expect(result.checks.some((check) => check.code === "claude_engine_selected")).toBe(true);
  });

  it("passes a valid credential end to end through the default ACP path", async () => {
    probeResult.value = {
      exitCode: 0,
      stdout: [
        initLine,
        '{"type":"result","subtype":"success","is_error":false,"result":"hello","session_id":"abc"}',
      ].join("\n"),
      stderr: "",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { command: "claude", env: { ANTHROPIC_API_KEY: "sk-ant-api03-valid" } },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    const passed = result.checks.find((check) => check.code === "claude_hello_probe_passed");
    expect(passed).toBeTruthy();
    expect(result.checks.some((check) => check.authFailure)).toBe(false);
  });

  it("stays permissive when the probe cannot run (claude CLI not resolvable), through the default ACP path", async () => {
    // Command-aware, not call-order-dependent: this rejects ONLY the
    // credential probe's own `claude` CLI resolvability check. The
    // pre-existing ACP-server command check (agentCommand,
    // "/opt/claude-agent-acp") is a different command string and keeps
    // resolving normally, so only the NEW probe-gating logic is exercised.
    claudeCliUnresolvable.value = true;

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        command: "claude",
        agentCommand: "/opt/claude-agent-acp",
        env: { ANTHROPIC_API_KEY: "sk-ant-api03-something" },
      },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    expect(result.status).not.toBe("fail");
    const unavailable = result.checks.find(
      (check) => check.code === "claude_acp_credential_probe_unavailable",
    );
    expect(unavailable).toBeTruthy();
    expect(unavailable?.level).toBe("warn");
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });
});
