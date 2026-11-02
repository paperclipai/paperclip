const listeners = new Set<(writtenAt: number) => void>();

export function onNativeRunnerEvidence(listener: (writtenAt: number) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function noteNativeRunnerEvidence(writtenAt: number): void {
  for (const listener of listeners) listener(writtenAt);
}
