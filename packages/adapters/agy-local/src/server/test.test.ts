import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";

const {
  ensureAdapterExecutionTargetDirectory,
  ensureAdapterExecutionTargetCommandResolvable,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  probeResult,
  capturedRuns,
} = vi.hoisted(() => {
  const probeResult: {
    value: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };
    throwError: Error | null;
  } = {
    value: { exitCode: 0, stdout: "", stderr: "" },
    throwError: null,
  };
  const capturedRuns: Array<{
    runId: string;
    target: any;
    command: string;
    args: string[];
    options: any;
  }> = [];

  return {
    probeResult,
    capturedRuns,
    ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    runAdapterExecutionTargetProcess: vi.fn(async (runId, target, command, args, options) => {
      capturedRuns.push({ runId, target, command, args, options });
      if (probeResult.throwError) throw probeResult.throwError;
      return {
        exitCode: probeResult.value.exitCode,
        signal: null,
        timedOut: probeResult.value.timedOut ?? false,
        stdout: probeResult.value.stdout,
        stderr: probeResult.value.stderr,
        pid: 123,
        startedAt: new Date().toISOString(),
      };
    }),
    describeAdapterExecutionTarget: vi.fn(() => "Local"),
    resolveAdapterExecutionTargetCwd: vi.fn((_target, cwd) => cwd || "/tmp/workspace"),
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
    runAdapterExecutionTargetProcess,
    describeAdapterExecutionTarget,
    resolveAdapterExecutionTargetCwd,
  };
});

import { testEnvironment } from "./test.js";

describe("agy-local testEnvironment", () => {
  beforeEach(() => {
    capturedRuns.length = 0;
    probeResult.throwError = null;
    probeResult.value = {
      exitCode: 0,
      stdout: JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", response: "hello there" },
      }) + "\n",
      stderr: "",
      timedOut: false,
    };
  });

  it("probes in read-only plan mode without --dangerously-skip-permissions by default", async () => {
    const ctx: AdapterEnvironmentTestContext = {
      companyId: "company-1",
      adapterType: "agy_local",
      config: {},
    };

    const result = await testEnvironment(ctx);
    expect(result.status).toBe("pass");
    expect(result.checks.some((c) => c.code === "agy_hello_probe_passed")).toBe(true);

    expect(capturedRuns).toHaveLength(1);
    const args = capturedRuns[0].args;
    expect(args).toContain("--print");
    expect(args).toContain("Respond with hello.");
    expect(args).toContain("--mode");
    expect(args[args.indexOf("--mode") + 1]).toBe("plan");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("does not include --dangerously-skip-permissions when explicitly set to false", async () => {
    const ctx: AdapterEnvironmentTestContext = {
      companyId: "company-1",
      adapterType: "agy_local",
      config: {
        dangerouslySkipPermissions: false,
      },
    };

    const result = await testEnvironment(ctx);
    expect(result.status).toBe("pass");

    expect(capturedRuns).toHaveLength(1);
    const args = capturedRuns[0].args;
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("includes --dangerously-skip-permissions only when explicitly configured true", async () => {
    const ctx: AdapterEnvironmentTestContext = {
      companyId: "company-1",
      adapterType: "agy_local",
      config: {
        dangerouslySkipPermissions: true,
      },
    };

    const result = await testEnvironment(ctx);
    expect(result.status).toBe("pass");

    expect(capturedRuns).toHaveLength(1);
    const args = capturedRuns[0].args;
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("respects configured mode if provided", async () => {
    const ctx: AdapterEnvironmentTestContext = {
      companyId: "company-1",
      adapterType: "agy_local",
      config: {
        mode: "accept-edits",
      },
    };

    const result = await testEnvironment(ctx);
    expect(result.status).toBe("pass");

    expect(capturedRuns).toHaveLength(1);
    const args = capturedRuns[0].args;
    expect(args).toContain("--mode");
    expect(args[args.indexOf("--mode") + 1]).toBe("accept-edits");
  });

  it("passes sandbox, agent persona, model, effort, and extraArgs", async () => {
    const ctx: AdapterEnvironmentTestContext = {
      companyId: "company-1",
      adapterType: "agy_local",
      config: {
        agent: "flutter_a11y_agent",
        sandbox: true,
        model: "gemini-3.7-flash-high",
        effort: "high",
        extraArgs: ["--custom-flag", "value"],
      },
    };

    const result = await testEnvironment(ctx);
    expect(result.status).toBe("pass");

    expect(capturedRuns).toHaveLength(1);
    const args = capturedRuns[0].args;
    expect(args).toContain("--sandbox");
    expect(args).toContain("--agent");
    expect(args[args.indexOf("--agent") + 1]).toBe("flutter_a11y_agent");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("gemini-3.7-flash-high");
    expect(args).toContain("--effort");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(args).toContain("--custom-flag");
    expect(args[args.indexOf("--custom-flag") + 1]).toBe("value");
  });

  it("records a warning if probe times out", async () => {
    probeResult.value = {
      exitCode: 1,
      stdout: "",
      stderr: "",
      timedOut: true,
    };

    const ctx: AdapterEnvironmentTestContext = {
      companyId: "company-1",
      adapterType: "agy_local",
      config: {},
    };

    const result = await testEnvironment(ctx);
    expect(result.status).toBe("warn");
    expect(result.checks.some((c) => c.code === "agy_hello_probe_timed_out")).toBe(true);
  });

  it("records an error if probe fails with non-zero exit code", async () => {
    probeResult.value = {
      exitCode: 1,
      stdout: "",
      stderr: "Error: model quota exceeded",
      timedOut: false,
    };

    const ctx: AdapterEnvironmentTestContext = {
      companyId: "company-1",
      adapterType: "agy_local",
      config: {},
    };

    const result = await testEnvironment(ctx);
    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.code === "agy_hello_probe_failed")).toBe(true);
  });
});
