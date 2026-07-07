const startLocksByAgent = new Map<string, Promise<void>>();

export async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  const previous = startLocksByAgent.get(agentId) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const marker = previous.then(
    () => current,
    () => current,
  );
  startLocksByAgent.set(agentId, marker);
  try {
    await previous.catch(() => undefined);
    return await fn();
  } finally {
    releaseCurrent();
    if (startLocksByAgent.get(agentId) === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}
