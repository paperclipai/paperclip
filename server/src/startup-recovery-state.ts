export type StartupRecoveryPhase = "starting" | "recovering" | "ready" | "draining";

let preservationBlocked = false;

const preservationListeners = new Set<() => void>();
export function setStartupPreservationBlocked(blocked: boolean): void {
  if (preservationBlocked === blocked) return;
  preservationBlocked = blocked;
  for (const listener of preservationListeners) listener();
}
export function subscribeStartupPreservationChanges(listener: () => void): () => void {
  preservationListeners.add(listener);
  return () => { preservationListeners.delete(listener); };
}
export function startupPreservationBlocked(): boolean { return preservationBlocked; }

let phase: StartupRecoveryPhase = "ready";
let updatedAt = new Date().toISOString();

export function setStartupRecoveryPhase(next: StartupRecoveryPhase): void {
  phase = next;
  updatedAt = new Date().toISOString();
}

export function getStartupRecoveryState(): {
  phase: StartupRecoveryPhase;
  updatedAt: string;
} {
  return { phase, updatedAt };
}

export function resetStartupRecoveryStateForTests(): void {
  preservationBlocked = false;
  phase = "ready";
  updatedAt = new Date().toISOString();
}
