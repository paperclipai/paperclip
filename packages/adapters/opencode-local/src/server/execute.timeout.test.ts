import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

const mocks = vi.hoisted(() => ({
  process: vi.fn(), restore: vi.fn(), stop: vi.fn(),
}));
vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => ({
  ...await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>(),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(),
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(),
  prepareAdapterExecutionTargetRuntime: vi.fn(async () => ({
    runtimeRootDir: "/workspace/runtime", workspaceRemoteDir: "/workspace",
    assetDirs: {}, restoreWorkspace: mocks.restore,
  })),
  readAdapterExecutionTargetHomeDir: vi.fn(async () => "/home/fixture"),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({ env: {}, stop: mocks.stop })),
  runAdapterExecutionTargetProcess: mocks.process,
}));
// The local path probes the installed CLI version. The fixture command in the
// deadline test never answers `--version`, so mock the probe to keep the test
// focused on the real timeout/termination behaviour instead of hanging.
vi.mock("./version.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./version.js")>(),
  probeOpenCodeCliVersion: vi.fn(async () => null),
}));
import { execute } from "./execute.js";

const rawOutput = "private-output-canary";
const rawError = "<html>504 Gateway Time-out private-provider-token-canary</html>";
const failed: RunProcessResult = {
  timedOut: true, exitCode: null, signal: null, stdout: rawOutput, stderr: rawError,
  pid: null, startedAt: "2020-01-01T00:00:00.000Z", durationMs: 100,
};

describe("OpenCode timeout reporting", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-timeout-"));
    vi.stubEnv("XDG_CONFIG_HOME", dir);
    mocks.process.mockReset().mockResolvedValue(failed);
    mocks.restore.mockReset().mockResolvedValue(undefined);
    mocks.stop.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const context = (timeoutSec: number, remote = true): AdapterExecutionContext => ({
    runId: "run-fixture",
    agent: { id: "agent-fixture", companyId: "company-fixture", name: "Fixture", adapterType: "opencode_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: "opencode", model: "openai/fixture", cwd: dir, timeoutSec,
      env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
    context: {}, onLog: async () => {},
    ...(remote ? { executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace" } } : {}),
  });

  it.each([
    [0, true, 14400, "sandbox_default"], [12, true, 12, "configured"],
    [-1, true, 0, "configured"], [0, false, 0, "unlimited"], [12, false, 12, "configured"],
  ] as const)("keeps policy separate from an opaque timeout (%s, remote=%s)", async (configured, remote, resolved, source) => {
    const result = await execute(context(configured, remote));
    expect(result).toMatchObject({ timedOut: true, exitCode: null, signal: null,
      errorMessage: "OpenCode execution timed out",
      resultJson: { adapterExecutionTimeout: { timeoutSec: resolved, source } } });
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(result.errorMessage).not.toContain(String(resolved));
    // A remote run probes the installed CLI generation (`--version`) before the
    // real invocation, so the run call follows the probe call.
    const runIndex = remote ? 1 : 0;
    expect(mocks.process).toHaveBeenCalledTimes(remote ? 2 : 1);
    expect(mocks.process.mock.calls[runIndex]![4]).toMatchObject({ timeoutSec: resolved, graceSec: 20 });
    expect(mocks.restore).toHaveBeenCalledTimes(remote ? 1 : 0);
    expect(mocks.stop).toHaveBeenCalledTimes(remote ? 1 : 0);
  });

  it.each([0, 7])("retains output and completion semantics for a non-timeout exit %s", async (exitCode) => {
    mocks.process.mockResolvedValue({ ...failed, timedOut: false, exitCode, stderr: "fixture failure" });
    const result = await execute(context(0));
    expect(result).toMatchObject({ timedOut: false, exitCode, signal: null,
      errorMessage: exitCode === 0 ? null : "fixture failure",
      resultJson: { stdout: rawOutput, stderr: "fixture failure",
        adapterExecutionTimeout: { timeoutSec: 14400, source: "sandbox_default" } } });
    // `context(0)` targets a remote sandbox, so it probes the CLI first.
    expect(mocks.process).toHaveBeenCalledTimes(2);
    expect(mocks.restore).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it("retains real local deadline and termination behavior without claiming provider origin", async () => {
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>("@paperclipai/adapter-utils/execution-target");
    mocks.process.mockImplementation(actual.runAdapterExecutionTargetProcess);
    const command = path.join(dir, "fixture-opencode");
    await fs.writeFile(command, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o755 });
    const ctx = context(0.1, false);
    ctx.config.command = command;
    ctx.config.graceSec = 0.1;
    const result = await execute(ctx);
    expect(result).toMatchObject({ timedOut: true, exitCode: null, signal: "SIGTERM",
      errorMessage: "OpenCode execution timed out",
      resultJson: { adapterExecutionTimeout: { timeoutSec: 0.1, source: "configured" } } });
    expect(mocks.process).toHaveBeenCalledTimes(1);
  });
});
