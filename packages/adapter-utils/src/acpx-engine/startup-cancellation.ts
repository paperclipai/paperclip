import type { AdapterExecutionContext } from "../types.js";
import type { CommandManagedRuntimeRunner } from "../command-managed-runtime.js";

/** Stop owns the sandbox before abandoning an outstanding startup RPC. The
 * original RPC may complete late; its result cannot restart preparation. */
export function cancellableSandboxStartup(ctx: AdapterExecutionContext) {
  const target = ctx.executionTarget;
  const signal = ctx.signal;
  const stop = ctx.stopRemoteStartup;
  if (!signal || !stop || target?.kind !== "remote" || target.transport !== "sandbox" || !target.runner) {
    return { context: ctx, finish: async () => {} };
  }
  let armed = true;
  let stopping: Promise<void> | undefined;
  const inFlight = new Set<Promise<unknown>>();
  let rejectStopped!: (error: unknown) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  // Cancellation can arrive between RPCs, when nobody is awaiting this yet.
  void stopped.catch(() => {});
  const onAbort = () => {
    if (stopping) return;
    stopping = Promise.resolve().then(stop);
    void stopping.then(
      () => rejectStopped(signal.reason ?? new Error("Stopped during sandbox startup")),
      // Without proof, the original operation still owns its resources. Do
      // not abandon it or release credentials while it could be running.
      () => {},
    );
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const joinStop = async () => {
    try {
      await stopping;
    } catch (error) {
      // Parallel setup may fail fast. Without a receipt, retain ownership of
      // every outstanding RPC, not only the first one that returns an error.
      await Promise.allSettled([...inFlight]);
      throw error;
    }
  };
  const guard = async <T>(call: () => Promise<T>): Promise<T> => {
    if (!armed && !stopping) return call();
    if (stopping) {
      await joinStop();
      return stopped;
    }
    const operation = Promise.resolve().then(() => {
      if (stopping) signal.throwIfAborted();
      return call();
    });
    inFlight.add(operation);
    void operation.then(() => inFlight.delete(operation), () => inFlight.delete(operation));
    try {
      return await Promise.race([operation, stopped]);
    } finally {
      if (stopping) {
        await joinStop();
        signal.throwIfAborted();
      }
    }
  };
  const original = target.runner;
  const runner: CommandManagedRuntimeRunner = {
    ...original,
    execute: input => guard(() => original.execute(input)),
    ...(original.syncIn ? { syncIn: (input: Parameters<NonNullable<typeof original.syncIn>>[0]) => guard(() => original.syncIn!(input)) } : {}),
    ...(original.syncOut ? { syncOut: (input: Parameters<NonNullable<typeof original.syncOut>>[0]) => guard(() => original.syncOut!(input)) } : {}),
    ...(original.openDuplexChannel ? {
      openDuplexChannel: (input: Parameters<NonNullable<typeof original.openDuplexChannel>>[0]) => guard(async () => {
        const channel = await original.openDuplexChannel!(input);
        // An open RPC can return after confirmed termination. Its host route
        // must not survive just because the caller already abandoned the RPC.
        if (stopping) await channel.close();
        return channel;
      }),
    } : {}),
  };
  return {
    context: { ...ctx, executionTarget: { ...target, runner } },
    async finish() {
      signal.removeEventListener("abort", onAbort);
      armed = false;
      if (stopping) await joinStop();
      signal.throwIfAborted();
    },
  };
}
