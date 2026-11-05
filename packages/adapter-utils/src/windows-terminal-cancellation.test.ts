import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const pending = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("./windows-terminal-job.js", () => ({ prepareWindowsTerminalJob: pending.prepare }));
import { runChildProcess } from "./server-utils.js";

describe.skipIf(process.platform !== "win32")("Windows terminal startup cancellation", () => {
  it("does not start the provider when cancellation wins during supervisor preparation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-cancel-prepare-"));
    const marker = path.join(dir, "started");
    let release!: () => void;
    let started!: () => void;
    const preparing = new Promise<void>((resolve) => { started = resolve; });
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const settle = vi.fn(async () => false);
    pending.prepare.mockImplementationOnce(async () => {
      started();
      await paused;
      return { command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`], stop: () => {}, settle };
    });
    const controller = new AbortController();
    try {
      const running = runChildProcess(randomUUID(), process.execPath, [], {
        cwd: dir, env: {}, timeoutSec: 10, graceSec: 1, onLog: async () => {}, signal: controller.signal,
        terminalResultCleanup: { windowsProcessTreeGuard: true, hasTerminalResult: () => false },
      });
      await preparing;
      controller.abort(new Error("cancelled during preparation"));
      release();
      await expect(running).rejects.toThrow("cancelled during preparation");
      expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
      expect(settle).toHaveBeenCalledOnce();
    } finally {
      release?.();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
