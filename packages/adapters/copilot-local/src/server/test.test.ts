import { describe, expect, it, vi } from "vitest";

const {
  runChildProcess,
  ensureCommandResolvable,
  ensureDirectory,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async (_runId: string, _target: unknown, command: string) => {
    if (command === "node") {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "v20.0.0\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      };
    }
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Authentication required. Run copilot login.",
      pid: 2,
      startedAt: new Date().toISOString(),
    };
  }),
  ensureCommandResolvable: vi.fn(async () => undefined),
  ensureDirectory: vi.fn(async () => undefined),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    runChildProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetDirectory: ensureDirectory,
    ensureAdapterExecutionTargetCommandResolvable: ensureCommandResolvable,
    runAdapterExecutionTargetProcess: runChildProcess,
  };
});

import { testEnvironment } from "./test.js";

describe("copilot environment test", () => {
  it("reports cwd validity, command presence, Node version, auth hints, and auth-required probe", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "copilot_local",
      config: {
        command: "copilot",
        cwd: process.cwd(),
      },
    });

    expect(result.status).toBe("warn");
    expect(result.checks.map((check) => check.code)).toEqual(expect.arrayContaining([
      "copilot_cwd_valid",
      "copilot_node_version",
      "copilot_command_resolvable",
      "copilot_auth_hint",
      "copilot_hello_probe_auth_required",
    ]));
  });
});
