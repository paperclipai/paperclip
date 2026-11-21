import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLocalProcessSandboxSpawnTarget } from "./local-process-sandbox.js";
import { runChildProcess } from "./server-utils.js";

vi.mock("./local-process-sandbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./local-process-sandbox.js")>()),
  buildLocalProcessSandboxSpawnTarget: vi.fn(),
}));

const cleanupDirs: string[] = [];

afterEach(async () => {
  vi.mocked(buildLocalProcessSandboxSpawnTarget).mockReset();
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("runChildProcess sandbox cleanup failures", () => {
  it("reports a failed cleanup after the child closes through onLogError", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-cleanup-close-"));
    cleanupDirs.push(workspace);
    const cleanupError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    vi.mocked(buildLocalProcessSandboxSpawnTarget).mockResolvedValue({
      command: "bwrap",
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      cleanup: () => Promise.reject(cleanupError),
    });
    const onLogError = vi.fn();

    const result = await runChildProcess("sandbox-cleanup-close", process.execPath, ["-e", "process.exit(0)"], {
      cwd: workspace,
      env: {},
      timeoutSec: 10,
      graceSec: 1,
      onLog: async () => {},
      onLogError,
      localProcessSandbox: { workspaceDir: workspace, command: process.execPath },
    });

    expect(result.exitCode).toBe(0);
    expect(onLogError).toHaveBeenCalledWith(cleanupError, "sandbox-cleanup-close", expect.any(String));
  });

  it("reports a failed cleanup after a spawn error through onLogError", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-cleanup-error-"));
    cleanupDirs.push(workspace);
    const cleanupError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    vi.mocked(buildLocalProcessSandboxSpawnTarget).mockResolvedValue({
      command: "bwrap",
      args: ["-e", "process.exit(0)"],
      cwd: path.join(workspace, "missing-cwd"),
      cleanup: () => Promise.reject(cleanupError),
    });
    const onLogError = vi.fn();

    await expect(
      runChildProcess("sandbox-cleanup-error", process.execPath, ["-e", "process.exit(0)"], {
        cwd: workspace,
        env: {},
        timeoutSec: 10,
        graceSec: 1,
        onLog: async () => {},
        onLogError,
        localProcessSandbox: { workspaceDir: workspace, command: process.execPath },
      }),
    ).rejects.toThrow("Failed to start command");
    await vi.waitFor(() =>
      expect(onLogError).toHaveBeenCalledWith(cleanupError, "sandbox-cleanup-error", expect.any(String)),
    );
  });
});
