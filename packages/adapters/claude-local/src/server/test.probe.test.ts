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
} = vi.hoisted(() => {
  const probeResult: { value: { exitCode: number; stdout: string; stderr: string } } = {
    value: { exitCode: 1, stdout: "", stderr: "" },
  };
  return {
    probeResult,
    ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
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
      config: { command: "claude", model: "claude-opus-4-8" },
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
      config: { command: "claude" },
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
      config: { command: "claude" },
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
      config: { command: "claude" },
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    const failed = result.checks.find((check) => check.code === "claude_hello_probe_failed");
    expect(failed?.detail).toBeUndefined();
  });
});
