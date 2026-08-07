import type { ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";

type FixtureProcess = {
  child: ChildProcess;
  label: string;
  processGroupId: number | null;
  graceMs: number;
};

export type FixtureSupervisorOptions = {
  owner: string;
  maxProcesses?: number;
};

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function signalFixtureProcess(record: FixtureProcess, signal: NodeJS.Signals): void {
  if (!isRunning(record.child)) return;
  if (process.platform !== "win32" && record.processGroupId && record.processGroupId > 0) {
    try {
      process.kill(-record.processGroupId, signal);
      return;
    } catch {
      // The direct ChildProcess handle remains the safe portable fallback.
    }
  }
  record.child.kill(signal);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isRunning(child)) return true;
  return await new Promise<boolean>((resolve) => {
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener("close", onClose);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    child.once("close", onClose);
    if (!isRunning(child)) {
      child.removeListener("close", onClose);
      clearTimeout(timer);
      resolve(true);
    }
  });
}

/**
 * Idempotent teardown registry for process-heavy tests.
 *
 * Register roots as soon as they are created and processes as soon as spawn
 * succeeds. Teardown always drains processes before removing roots, including
 * when setup throws part way through. The stable Vitest invocation supervisor
 * remains the outer crash/timeout boundary when Vitest hooks cannot run.
 */
export class FixtureSupervisor {
  readonly owner: string;
  readonly maxProcesses: number;
  readonly processes: FixtureProcess[] = [];
  readonly roots = new Set<string>();
  readonly cleanups: Array<() => Promise<void> | void> = [];
  private teardownPromise: Promise<void> | null = null;

  constructor(options: FixtureSupervisorOptions) {
    this.owner = options.owner;
    this.maxProcesses = options.maxProcesses ?? 16;
  }

  registerRoot(root: string): string {
    this.roots.add(root);
    return root;
  }

  registerProcess(
    child: ChildProcess,
    options: { label: string; processGroupId?: number | null; graceMs?: number },
  ): ChildProcess {
    if (this.processes.length >= this.maxProcesses) {
      signalFixtureProcess(
        {
          child,
          label: options.label,
          processGroupId: options.processGroupId ?? null,
          graceMs: options.graceMs ?? 2_000,
        },
        "SIGKILL",
      );
      throw new Error(
        `Fixture process budget exceeded for ${this.owner}: ` +
          `${this.processes.length + 1}/${this.maxProcesses} while registering ${options.label}.`,
      );
    }
    this.processes.push({
      child,
      label: options.label,
      processGroupId: options.processGroupId ?? null,
      graceMs: options.graceMs ?? 2_000,
    });
    return child;
  }

  registerCleanup(cleanup: () => Promise<void> | void): void {
    this.cleanups.push(cleanup);
  }

  async teardown(): Promise<void> {
    if (this.teardownPromise) return this.teardownPromise;
    this.teardownPromise = this.teardownOnce();
    return this.teardownPromise;
  }

  private async teardownOnce(): Promise<void> {
    const failures: string[] = [];
    for (const record of [...this.processes].reverse()) {
      if (!isRunning(record.child)) continue;
      signalFixtureProcess(record, "SIGTERM");
      if (!(await waitForExit(record.child, record.graceMs))) {
        signalFixtureProcess(record, "SIGKILL");
        if (!(await waitForExit(record.child, Math.max(1_000, Math.floor(record.graceMs / 2))))) {
          failures.push(`${record.label} did not exit after SIGKILL`);
        }
      }
    }
    for (const cleanup of [...this.cleanups].reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length > 0) {
      throw new Error(`Fixture teardown failed for ${this.owner}: ${failures.join("; ")}`);
    }
    for (const root of [...this.roots].reverse()) {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}

export async function withFixtureSupervisor<T>(
  options: FixtureSupervisorOptions,
  setup: (supervisor: FixtureSupervisor) => Promise<T>,
): Promise<T> {
  const supervisor = new FixtureSupervisor(options);
  try {
    return await setup(supervisor);
  } catch (error) {
    await supervisor.teardown();
    throw error;
  }
}
