type LaunchLockState = {
  locked: boolean;
  waiters: Array<() => void>;
};

const launchLocksByAgent = new Map<string, LaunchLockState>();

/**
 * Serializes the tiny boundary between control-plane cancellation and adapter
 * process launch. Callers must release promptly; this lock is intentionally
 * not used for the lifetime of the child process.
 */
export async function acquireAgentLaunchLock(agentId: string): Promise<() => void> {
  let state = launchLocksByAgent.get(agentId);
  if (!state) {
    state = { locked: false, waiters: [] };
    launchLocksByAgent.set(agentId, state);
  }

  if (state.locked) {
    await new Promise<void>((resolve) => {
      state!.waiters.push(resolve);
    });
  } else {
    state.locked = true;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;

    const next = state!.waiters.shift();
    if (next) {
      next();
      return;
    }

    state!.locked = false;
    if (launchLocksByAgent.get(agentId) === state) {
      launchLocksByAgent.delete(agentId);
    }
  };
}
