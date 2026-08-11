import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { monitorWindowsRunSupervisor, superviseWindowsRun } from "../commands/run.js";

describe("Windows run supervisor", () => {
  it("starts a hidden detached IPC child and relays console-control events", async () => {
    const processEvents = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      connected: true,
      send: vi.fn(() => true),
    }) as unknown as ChildProcess;
    const spawnChild = vi.fn(() => child) as unknown as typeof spawn;
    const supervisorProcess = {
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      pid: 8080,
      execArgv: ["--import", "tsx"],
      argv: ["node", "cli/src/index.ts", "run"],
      env: { PAPERCLIP_HOME: "C:\\paperclip" },
      on: (event: string, listener: (...args: unknown[]) => void) => {
        processEvents.on(event, listener);
        return supervisorProcess;
      },
      off: (event: string, listener: (...args: unknown[]) => void) => {
        processEvents.off(event, listener);
        return supervisorProcess;
      },
    };

    const supervised = superviseWindowsRun({
      process: supervisorProcess as never,
      spawnChild,
    });

    expect(spawnChild).toHaveBeenCalledWith(
      supervisorProcess.execPath,
      ["--import", "tsx", "cli/src/index.ts", "run"],
      expect.objectContaining({
        detached: true,
        windowsHide: true,
        env: expect.objectContaining({
          PAPERCLIP_WINDOWS_RUN_CHILD: "1",
          PAPERCLIP_WINDOWS_RUN_SUPERVISOR_PID: "8080",
        }),
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      }),
    );

    processEvents.emit("SIGBREAK");
    expect(child.send).toHaveBeenCalledWith({
      type: "paperclip-windows-run-shutdown",
      signal: "SIGBREAK",
    });

    child.emit("exit", 0, null);
    await expect(supervised).resolves.toBeUndefined();
    expect(processEvents.listenerCount("SIGBREAK")).toBe(0);
  });

  it("requests shutdown when an abruptly terminated supervisor cannot relay a signal", async () => {
    vi.useFakeTimers();
    const onExit = vi.fn();
    const stop = monitorWindowsRunSupervisor({
      supervisorPid: "8080",
      onExit,
      isProcessAlive: vi.fn(() => false),
    });
    try {
      await vi.advanceTimersByTimeAsync(250);
      expect(onExit).toHaveBeenCalledOnce();
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
});
