import type { ChildProcess } from "node:child_process";

export type TestPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  process?: ChildProcess;
};

type Owner = { stop(clean?: boolean): Promise<void>; interrupt(): void };
export class TestPostgresShutdownError extends Error {}
const owners = new Set<Owner>();
type ShutdownTask = { stop(signal: NodeJS.Signals): Promise<void>; interrupt(): void };
const shutdownTasks = new Set<ShutdownTask>();
let shuttingDown = false;
let hooksInstalled = false;

function interruptOwnedServers(): void {
  for (const task of shutdownTasks) task.interrupt();
  for (const owner of owners) owner.interrupt();
}

export function beforeTestPostgresShutdown(task: ShutdownTask): () => void {
  shutdownTasks.add(task);
  updateHooks();
  return () => { shutdownTasks.delete(task); updateHooks(); };
}

export async function drainTestPostgresOwners(): Promise<void> {
  const results = await Promise.allSettled([...owners].map((owner) => owner.stop()));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Test PostgreSQL shutdown failed");
}

async function shutdown(signal: "SIGINT" | "SIGTERM" | "SIGHUP"): Promise<void> {
  if (shuttingDown) { interruptOwnedServers(); return; }
  shuttingDown = true;
  const tasks = await Promise.allSettled([...shutdownTasks].map((task) => task.stop(signal)));
  for (const result of tasks) {
    if (result.status === "rejected") console.error(result.reason);
  }
  try { await drainTestPostgresOwners(); }
  catch (error) { console.error(error); }
  process.exit(128 + { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal]);
}

const onInterrupt = () => { void shutdown("SIGINT"); };
const onTerminate = () => { void shutdown("SIGTERM"); };
const onHangup = () => { void shutdown("SIGHUP"); };

function updateHooks(): void {
  if ((owners.size > 0 || shutdownTasks.size > 0) && !hooksInstalled) {
    hooksInstalled = true;
    process.on("exit", interruptOwnedServers);
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    process.on("SIGHUP", onHangup);
  } else if (owners.size === 0 && shutdownTasks.size === 0) {
    hooksInstalled = false;
    process.removeListener("exit", interruptOwnedServers);
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    process.removeListener("SIGHUP", onHangup);
  }
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function ownTestPostgres(instance: TestPostgresInstance): Pick<TestPostgresInstance, "initialise" | "start" | "stop"> & {
  stopGracefully(): Promise<void>;
} {
  let pending: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let stopped = false;
  let usedImmediateShutdown = false;
  let stoppedCleanly = false;

  async function run(operation: () => Promise<void>): Promise<void> {
    if (stopped || stopPromise) throw new Error("Test PostgreSQL is shutting down");
    const running = operation();
    pending = running;
    try { await running; }
    finally { if (pending === running) pending = null; }
  }

  const owner: Owner = {
    interrupt() {
      const child = instance.process;
      if (process.platform !== "win32" && child && child.exitCode === null && child.signalCode === null) {
        usedImmediateShutdown = true;
        try { child.kill("SIGQUIT"); } catch {}
      }
    },
    stop(clean = false) {
      if (stopped) return Promise.resolve();
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        if (pending && !await settlesWithin(pending.catch(() => {}), 30_000)) {
          throw new TestPostgresShutdownError("Test PostgreSQL startup did not settle before shutdown; its data directory is retained");
        }
        const child = instance.process;
        if (!child || (process.platform === "win32" && child.exitCode === null && child.signalCode === null)) {
          if (!await settlesWithin(instance.stop(), 10_000)) {
            throw new TestPostgresShutdownError("Test PostgreSQL shutdown timed out; its data directory is retained");
          }
        } else if (child.exitCode === null && child.signalCode === null) {
          let onExit: () => void;
          const exited = new Promise<void>((resolve) => { onExit = resolve; child.once("exit", onExit); });
          try {
            child.kill("SIGINT");
            if (!await settlesWithin(exited, clean ? 30_000 : 5_000)) {
              if (clean) throw new TestPostgresShutdownError("Test PostgreSQL did not complete clean shutdown; the template cannot be published");
              usedImmediateShutdown = true;
              child.kill("SIGQUIT");
              if (!await settlesWithin(exited, 5_000)) {
                throw new TestPostgresShutdownError("Test PostgreSQL did not exit after fast and immediate shutdown; its data directory is retained");
              }
            }
          } finally {
            child.removeListener("exit", onExit!);
          }
        }
        stoppedCleanly = !usedImmediateShutdown && (!child || (child.exitCode === 0 && child.signalCode === null));
        if (clean && !stoppedCleanly) {
          throw new TestPostgresShutdownError("Test PostgreSQL exited without clean shutdown; the template cannot be published");
        }
        instance.process = undefined;
        stopped = true;
        owners.delete(owner);
        updateHooks();
      })().catch((error) => {
        stopPromise = null;
        if (error instanceof TestPostgresShutdownError) throw error;
        throw new TestPostgresShutdownError("Test PostgreSQL shutdown failed; its data directory is retained", { cause: error });
      });
      return stopPromise;
    },
  };
  owners.add(owner);
  if (owners.size === 1) updateHooks();
  return {
    initialise: () => run(() => instance.initialise()),
    start: () => run(() => instance.start()),
    stop: () => owner.stop(),
    stopGracefully: async () => {
      await owner.stop(true);
      if (!stoppedCleanly) throw new TestPostgresShutdownError("Test PostgreSQL exited without clean shutdown; the template cannot be published");
    },
  };
}
