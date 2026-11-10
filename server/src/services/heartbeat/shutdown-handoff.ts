const runsHandedOffForShutdown = new Map<string, symbol>();

export function markRunHandedOffForShutdown(runId: string) {
  runsHandedOffForShutdown.set(runId, Symbol("shutdown handoff"));
}

export function watchShutdownHandoff(runId: string): () => boolean {
  const atStart = runsHandedOffForShutdown.get(runId);
  return () => {
    const current = runsHandedOffForShutdown.get(runId);
    return current !== undefined && current !== atStart;
  };
}
