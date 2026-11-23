import { execFile, spawn } from "node:child_process";
import { constants } from "node:os";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);

export function startTestProcessTree(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const posix = process.platform !== "win32";
  const child = spawn(command, args, { stdio: "inherit", env, detached: posix });
  let exited = false;
  let stopping: Promise<void> | null = null;
  let retired = false;
  const exit = new Promise<number>((resolve, reject) => {
    child.once("error", (error) => { exited = true; reject(error); });
    child.once("exit", (code, signal) => {
      exited = true;
      resolve(code ?? (signal ? 128 + constants.signals[signal] : 1));
    });
  });

  async function alive(): Promise<boolean> {
    if (!child.pid) return false;
    if (!posix) return !exited;
    const { stdout } = await execute("/bin/ps", ["-axo", "pgid=,stat="], { timeout: 2000, maxBuffer: 1024 * 1024 });
    return stdout.split("\n").some((line) => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === child.pid && state && !state.startsWith("Z");
    });
  }

  function signal(signal: NodeJS.Signals): void {
    if (!child.pid || retired) return;
    try {
      if (posix) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  async function waitUntilStopped(milliseconds: number): Promise<boolean> {
    const deadline = Date.now() + milliseconds;
    do {
      if (!await alive()) return true;
      await setTimeout(50);
    } while (Date.now() < deadline);
    return false;
  }

  function stop(requested: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      if (posix) {
        signal(requested);
        if (!await waitUntilStopped(15_000)) {
          signal("SIGKILL");
          if (!await waitUntilStopped(5_000)) throw new Error("Test command process group did not stop");
        }
      } else if (child.pid && !exited) {
        await execute("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 15_000 });
      }
      await exit;
      retired = true;
    })();
    return stopping;
  }

  return {
    stop,
    interrupt: () => signal("SIGTERM"),
    async wait(): Promise<number> {
      const status = await exit;
      await stop();
      return status;
    },
  };
}
