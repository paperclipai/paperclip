import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLocalProcessSandboxSpawnTarget } from "./local-process-sandbox.js";
import { runChildProcess, runningProcesses } from "./server-utils.js";

vi.mock("./local-process-sandbox.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./local-process-sandbox.js")>(),
  buildLocalProcessSandboxSpawnTarget: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
});

describe("runChildProcess sandbox cleanup", () => {
  it.each(["close", "error"] as const)(
    "handles rejected cleanup after child %s without changing the run outcome",
    async (event) => {
      const runId = `cleanup-rejection-${event}`;
      const cleanupError = Object.assign(new Error("cleanup denied"), { code: "EACCES" });
      const cleanup = vi.fn(async () => { throw cleanupError; });
      const onLogError = vi.fn();
      vi.mocked(buildLocalProcessSandboxSpawnTarget).mockResolvedValue({
        command: process.execPath,
        args: ["--version"],
        cwd: event === "close" ? process.cwd() : path.join(process.cwd(), "missing-cleanup-test-directory"),
        cleanup,
      });

      const result = runChildProcess(runId, process.execPath, ["--version"], {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 0,
        graceSec: 1,
        onLog: async () => {},
        onLogError,
        localProcessSandbox: { command: process.execPath, workspaceDir: process.cwd() },
      });

      if (event === "close") {
        await expect(result).resolves.toMatchObject({ exitCode: 0, signal: null, timedOut: false });
      } else {
        await expect(result).rejects.toThrow(/Failed to start command/);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(cleanup).toHaveBeenCalled();
      expect(onLogError).toHaveBeenCalledWith(cleanupError, runId, expect.any(String));
      expect(runningProcesses.has(runId)).toBe(false);
    },
  );
});
