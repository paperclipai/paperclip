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

/** This process handed the run to the next server (graceful drain or hot restart). */
export function isRunHandedOffForShutdown(runId: string): boolean {
  return runsHandedOffForShutdown.has(runId);
}
