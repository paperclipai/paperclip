import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

// The managed-config step runs inside `prepareSandboxClaudeProbeRuntime`. The
// step resolves the Paperclip instance root first. This mock makes that resolve
// throw, so the managed-config materialization fails with a controllable error
// that carries a secret marker.
const { resolveInstanceRoot } = vi.hoisted(() => {
  const resolveInstanceRoot: { throwError: Error | null } = { throwError: null };
  return { resolveInstanceRoot };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    maybeRunSandboxInstallCommand: vi.fn(async () => null),
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    resolvePaperclipInstanceRootForAdapter: (...args: unknown[]) => {
      if (resolveInstanceRoot.throwError) throw resolveInstanceRoot.throwError;
      return (
        actual.resolvePaperclipInstanceRootForAdapter as (...a: unknown[]) => string
      )(...args);
    },
  };
});

import { prepareSandboxClaudeProbeRuntime } from "./claude-config.js";

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

afterEach(() => {
  vi.clearAllMocks();
  resolveInstanceRoot.throwError = null;
});

describe("prepareSandboxClaudeProbeRuntime managed-config redaction", () => {
  it("never copies a materialization error into a Test-result check", async () => {
    // A materialization failure can carry a credential. Inject a secret marker
    // through the thrown error and assert no check text repeats it.
    const secret = "sk-ant-MANAGEDMARKER0123456789abcdef";
    resolveInstanceRoot.throwError = new Error(`materialize failed with ${secret}`);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const checks = await prepareSandboxClaudeProbeRuntime({
      runId: "test-run",
      target: sandboxTarget,
      cwd: "/home/daytona/paperclip-workspace",
      env: {},
      installCommand: "npm i -g @anthropic-ai/claude-code",
      detectCommand: "claude --version",
      targetIsRemote: true,
      targetIsSandbox: true,
      helloProbeTimeoutSec: 5,
    });

    const failedCheck = checks.find((check) => check.code === "claude_managed_config_dir_failed");
    expect(failedCheck).toBeDefined();
    expect(failedCheck?.level).toBe("error");

    const checkText = JSON.stringify(checks);
    expect(checkText).not.toContain(secret);
    expect(checkText).not.toContain("MANAGEDMARKER");
    // The diagnostic still reaches the server log, but the secret is redacted.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain(secret);
    expect(loggedText).toContain("***REDACTED***");
    warnSpy.mockRestore();
  });
});
