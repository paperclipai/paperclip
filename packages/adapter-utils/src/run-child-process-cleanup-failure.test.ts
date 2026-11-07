import { describe, expect, it, vi } from "vitest";

vi.mock("./local-process-sandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./local-process-sandbox.js")>();
  return {
    ...actual,
    buildLocalProcessSandboxSpawnTarget: vi.fn(async (input: { executable: string; args: string[]; cwd: string }) => ({
      command: input.executable,
      args: input.args,
      cwd: input.cwd,
      cleanup: async () => {
        throw new Error("EACCES: permission denied");
      },
    })),
  };
});

import { runChildProcess } from "./server-utils.js";

describe("runChildProcess sandbox cleanup failure", () => {
  it("resolves and reports the error through onLogError when cleanup rejects after close", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    const onLogError = vi.fn();
    try {
      const result = await runChildProcess("cleanup-close", process.execPath, ["-e", "process.exit(0)"], {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 20,
        graceSec: 1,
        onLog: async () => {},
        onLogError,
        localProcessSandbox: { workspaceDir: process.cwd(), networkScope: "deny", command: process.execPath },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(result.exitCode).toBe(0);
      expect(unhandled).toEqual([]);
      expect(onLogError).toHaveBeenCalledWith(expect.any(Error), "cleanup-close", expect.any(String));
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("does not leak an unhandled rejection when the child fails to spawn", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    const onLogError = vi.fn();
    try {
      await expect(
        runChildProcess("cleanup-error", process.execPath, ["-e", "0"], {
          cwd: "/nonexistent-dir-for-cleanup-test",
          env: {},
          timeoutSec: 20,
          graceSec: 1,
          onLog: async () => {},
          onLogError,
          localProcessSandbox: { workspaceDir: process.cwd(), networkScope: "deny", command: process.execPath },
        }),
      ).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});
