import type { ChildProcess } from "node:child_process";
import { createProcessTreeOwner, incompleteTreeFallback, type RestartRunnerIdentity } from "./process-tree-owner.js";

// The wrapper receives Playwright's group signal; only it signals Paperclip.
export const runnerE2EServerDetached = process.platform !== "win32";
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function createRunnerE2EServerStopper(options: {
  gracefulTimeoutMs: number;
  forcedTimeoutMs: number;
  hasSpawnError: (child: ChildProcess) => boolean;
  markExpectedStop: (child: ChildProcess) => void;
  log: (message: string) => void;
  createOwner?: typeof createProcessTreeOwner;
}) {
  type State = {
    owner: ReturnType<typeof createProcessTreeOwner>;
    promise?: Promise<void>;
    restartPromise?: Promise<void>;
    finalRequested?: boolean;
    finalPhaseStarted?: boolean;
    finalComplete?: boolean;
    gracefulDeadline?: number;
    forcedDeadline?: number;
    gracefulSent: boolean;
    groupSignals: Set<number>;
    escalationLogged: boolean;
  };
  const states = new WeakMap<ChildProcess, State>();
  const watched = new Set<ChildProcess>();
  let finalGraceDeadline: number | undefined;
  let finalForcedDeadline: number | undefined;
  let finalAllPromise: Promise<void> | undefined;
  const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null || options.hasSpawnError(child);
  function watch(child: ChildProcess) {
    let state = states.get(child);
    if (!state) {
      state = { owner: (options.createOwner ?? createProcessTreeOwner)(child), gracefulSent: false, groupSignals: new Set(), escalationLogged: false };
      states.set(child, state);
      watched.add(child);
    }
    return state;
  }
  async function stopOnce(child: ChildProcess, state: State, signal: NodeJS.Signals, restarting = false) {
    state.gracefulDeadline ??= Date.now() + options.gracefulTimeoutMs;
    await state.owner.observe();
    if (!exited(child) && !state.gracefulSent) {
      state.gracefulSent = child.kill(signal);
    }
    while (Date.now() < state.gracefulDeadline) {
      await state.owner.observe();
      if (restarting && state.finalRequested) throw new Error("Final shutdown interrupted controller restart");
      if (exited(child)) {
        if (restarting) {
          state.owner.assertRestartRunnerAlive();
          if (!state.owner.restartCleanupGroups().size) return;
        }
        if (!state.owner.liveGroups().length) { state.owner.stopObserving(); return; }
        // The leader is gone. Retire only descendants whose start identities
        // we observed while they belonged to this server, including private groups.
        const unsignaled = new Set((restarting ? [...state.owner.restartCleanupGroups()] : state.owner.liveGroups().map(group => group.processGroupId)).filter(pid => !state.groupSignals.has(pid)));
        for (const pid of await state.owner.signal("SIGTERM", unsignaled)) state.groupSignals.add(pid);
      }
      await wait(25);
    }
    if (restarting) throw new Error("Controller restart did not retire non-durable children within its graceful deadline");
    if (!state.escalationLogged) {
      options.log(`\nPaperclip did not stop within ${options.gracefulTimeoutMs}ms; sending SIGKILL\n`);
      state.escalationLogged = true;
    }
    if (runnerE2EServerDetached) await state.owner.signal("SIGKILL");
    else if (!exited(child)) child.kill("SIGKILL");
    state.forcedDeadline ??= finalForcedDeadline ?? Date.now() + options.forcedTimeoutMs;
    do {
      await state.owner.observe();
      if (exited(child) && !state.owner.liveGroups().length) { state.owner.stopObserving(); return; }
      await wait(25);
    } while (Date.now() < state.forcedDeadline);
    throw new Error("Paperclip server or observed descendants did not exit after SIGKILL");
  }
  const stop = (child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> => {
    options.markExpectedStop(child);
    const state = watch(child);
    state.finalRequested = true;
    state.promise ??= Promise.resolve().then(async () => {
      if (state.restartPromise && !state.finalPhaseStarted) {
        await state.restartPromise.catch(() => {});
        state.finalPhaseStarted = true;
        // A completed restart is a separate phase, not elapsed cleanup time.
        state.gracefulDeadline = finalGraceDeadline ?? Date.now() + options.gracefulTimeoutMs;
        state.forcedDeadline = undefined;
        state.groupSignals.clear();
      }
      await stopOnce(child, state, signal);
      state.finalComplete = true;
    }).catch(async error => {
      try {
        await incompleteTreeFallback(error, child, state, state.gracefulDeadline!, options.forcedTimeoutMs);
      } finally {
        state.promise = undefined;
      }
    });
    /* Retain the signal/deadline phase so a later audit can recover without
       repeating the graceful signal. */
    return state.promise;
  };
  return Object.assign(stop, {
    watch: (child: ChildProcess) => watch(child).owner.observe(),
    forRestart: (child: ChildProcess, identity: RestartRunnerIdentity): Promise<void> => {
      options.markExpectedStop(child);
      const state = watch(child);
      if (state.finalRequested || state.restartPromise) return Promise.reject(new Error("Restart already requested or final cleanup active"));
      state.restartPromise = (async () => {
        await state.owner.preserveRunnerForRestart(identity);
        options.log(`Controller restart preserves admitted runner pid=${identity.processPid} pgid=${identity.processGroupId} started=${identity.processStartedAt}\n`);
        await stopOnce(child, state, "SIGTERM", true);
      })();
      return state.restartPromise;
    },
    stopAll: (signal: NodeJS.Signals = "SIGTERM"): Promise<void> => {
      // Replacement controller drain precedes old daemon retirement. All
      // generations share the original final-cleanup window, including retries.
      finalGraceDeadline ??= Math.min(Date.now() + options.gracefulTimeoutMs,
        ...[...watched].map(child => states.get(child)!).filter(state => state.finalRequested && !state.finalComplete
          && (!state.restartPromise || state.finalPhaseStarted)).map(state => state.gracefulDeadline ?? Infinity));
      finalForcedDeadline ??= finalGraceDeadline + options.forcedTimeoutMs;
      for (const child of watched) {
        const state = states.get(child)!;
        state.finalRequested = true;
        state.gracefulDeadline ??= finalGraceDeadline;
      }
      finalAllPromise ??= Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        for (const child of [...watched].reverse()) {
          try { await stop(child, signal); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, "Owned server cleanup incomplete");
      }).catch(error => { finalAllPromise = undefined; throw error; });
      return finalAllPromise;
    },
  });
}
