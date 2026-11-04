import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

// Keep the real directory, command and adapter checks. Runtime staging is a
// separate operation and must not copy files or contact a provider in this test.
vi.mock("@paperclipai/adapter-utils/execution-target", async importOriginal => ({
  ...await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>(),
  prepareAdapterExecutionTargetRuntime: async () => ({
    workspaceRemoteDir: "/workspace", runtimeRootDir: "/workspace/.paperclip-runtime",
    assetDirs: {}, restoreWorkspace: async () => {},
  }),
}));

import { testEnvironment } from "@paperclipai/adapter-opencode-local/server";
import { assertHarnessTestPassed } from "../services/agent-harness-verification.js";
import { lifecycleFailureMessage, lifecycleVerificationNeedsRetry } from "../modules/agent-lifecycle/application/failure.js";

describe("remote harness verification recovery", () => {
  let configHome: string;
  beforeAll(async () => { configHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-verification-")); });
  afterAll(async () => { if (configHome) await rm(configHome, { recursive: true, force: true }); });
  const context = { stage: "host" as const, phase: "verifying" as const, verificationFailures: 100 };

  it.each([
    ["directory", "timeout"], ["directory", "transport"],
    ["command", "timeout"], ["command", "transport"],
    ["directory", "missing"], ["command", "missing"],
  ] as const)("retains %s %s through the real adapter check and recovers when repaired", async (check, fault) => {
    let failing = true;
    const target: AdapterExecutionTarget = {
      kind: "remote", transport: "sandbox", remoteCwd: "/workspace", runner: {
        execute: async input => {
          const script = input.args?.join(" ") ?? "";
          const selected = check === "directory" ? script.includes("[ -d ") : script.includes("command -v ");
          if (failing && selected && fault === "transport") {
            throw Object.assign(new Error("private provider output"), { code: "ECONNRESET" });
          }
          return {
            exitCode: failing && selected ? fault === "timeout" ? null : 1 : 0,
            timedOut: failing && selected && fault === "timeout", signal: null, stderr: "", pid: null,
            startedAt: new Date().toISOString(),
            stdout: input.command === "opencode" ? JSON.stringify({ type: "text", part: { text: "hello" } }) : "",
          };
        },
      },
    };
    const run = () => testEnvironment({ companyId: "company", adapterType: "opencode_local", executionTarget: target,
      config: { command: "opencode", model: "provider/model", env: { XDG_CONFIG_HOME: configHome } } });
    const result = await run();
    const failed = result.checks.find(entry => entry.code === (check === "directory" ? "opencode_cwd_invalid" : "opencode_command_unresolvable"));
    expect(failed?.level).toBe("error");
    expect(failed?.retryable === true).toBe(fault !== "missing");
    let error: unknown;
    try { assertHarnessTestPassed(result); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: fault !== "missing" ? "test_environment_unavailable"
      : check === "directory" ? "harness_cwd_invalid" : "harness_command_unavailable" });
    expect(lifecycleVerificationNeedsRetry(context, error)).toBe(fault === "missing");
    expect(lifecycleFailureMessage(context, error)).not.toContain("private provider output");
    if (fault !== "missing") expect(lifecycleFailureMessage(context, error)).toContain("retry automatically");
    failing = false;
    const recovered = await run();
    expect(() => assertHarnessTestPassed(recovered)).not.toThrow();
  });
});
