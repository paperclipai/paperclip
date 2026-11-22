import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { usesOpenCodeV2 } from "./version.js";

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  runAdapterExecutionTargetProcess: vi.fn(),
}));

const run = vi.mocked(runAdapterExecutionTargetProcess);
const input = {
  runId: "fixture-run",
  target: { kind: "remote", transport: "sandbox", providerKey: "fixture", remoteCwd: "/workspace" } as const,
  command: "opencode",
  cwd: "/workspace",
  env: { PATH: "/bin" },
  timeoutSec: 3,
};
const result = { exitCode: 0, timedOut: false, signal: null, stdout: "", stderr: "", pid: null,
  startedAt: "2020-01-01T00:00:00.000Z", durationMs: 1 };

beforeEach(() => {
  run.mockReset();
});

describe("OpenCode version detection", () => {
  it.each([
    ["1.18.34", false],
    ["opencode v2.3.2", true],
    ["unknown", false],
  ])("detects %s on the execution target", async (stdout, expected) => {
    run.mockResolvedValue({ ...result, stdout });
    expect(await usesOpenCodeV2(input)).toBe(expected);
    expect(run).toHaveBeenCalledWith(
      input.runId, input.target, input.command, ["--version"],
      expect.objectContaining({ cwd: input.cwd, env: input.env, timeoutSec: 3 }),
    );
  });

  it("preserves legacy behavior if the version check fails", async () => {
    run.mockRejectedValue(new Error("unavailable"));
    expect(await usesOpenCodeV2(input)).toBe(false);
  });

  it.each([
    { exitCode: 1, timedOut: false },
    { exitCode: null, timedOut: true },
  ])("preserves legacy behavior when the version probe does not succeed", async (status) => {
    run.mockResolvedValue({ ...result, ...status, stdout: "opencode v2.3.2" });
    expect(await usesOpenCodeV2(input)).toBe(false);
  });

  it("does not continue after the version process is interrupted", async () => {
    run.mockResolvedValue({ ...result, signal: "SIGTERM" });
    await expect(usesOpenCodeV2(input)).rejects.toThrow("version check was interrupted");
  });

  it("does not continue after the run is cancelled during the version check", async () => {
    const controller = new AbortController();
    run.mockImplementation(async () => {
      controller.abort();
      return result;
    });
    await expect(usesOpenCodeV2({ ...input, signal: controller.signal })).rejects.toThrow();
  });
});
