type AgentStartLock = {
  promise: Promise<void>;
  startedAt: number;
};

export function createAgentStartLockController() {
  const startLocksByAgent = new Map<string, AgentStartLock>();

  return {
    async withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
      const previous = startLocksByAgent.get(agentId)?.promise ?? Promise.resolve();
      const run = previous.then(fn);
      const marker = run.then(
        () => undefined,
        () => undefined,
      );
      const lock: AgentStartLock = {
        promise: marker,
        startedAt: Date.now(),
      };
      startLocksByAgent.set(agentId, lock);
      try {
        return await run;
      } finally {
        if (startLocksByAgent.get(agentId) === lock) {
          startLocksByAgent.delete(agentId);
        }
      }
    },
    clear() {
      startLocksByAgent.clear();
    },
    seed(agentId: string, startedAt: number, promise: Promise<void> = new Promise<void>(() => {})) {
      startLocksByAgent.set(agentId, { promise, startedAt });
    },
  };
}
