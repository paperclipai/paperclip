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

const skillStorageListeners = new Set<(preparedAt: number) => void>();

/** A local launch prepared skills (a shared skill home or staging): cleanup is due a day later. */
export function onNativeRunnerSkillStorage(listener: (preparedAt: number) => void): () => void {
  skillStorageListeners.add(listener);
  return () => {
    skillStorageListeners.delete(listener);
  };
}

export function noteNativeRunnerSkillStorage(preparedAt: number): void {
  for (const listener of skillStorageListeners) listener(preparedAt);
}
