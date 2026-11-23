export type StartupRecoveryPhase = "starting" | "recovering" | "ready" | "draining";

let phase: StartupRecoveryPhase = "ready";
let updatedAt = new Date().toISOString();
let queuedRunPassPending = false;

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

/** The server reports ready before its first full queued-run dispatch pass
 * finishes; that pass scales with the backlog. Until it does, a queued turn
 * still waits on this server's recovery, not on anything the user can change. */
export function setStartupQueuedRunPassPending(pending: boolean): void {
  queuedRunPassPending = pending;
}

/** True while this process has not yet run its full queued-run pass: before
 * ready, while draining, or after ready until the first pass finishes. */
export function startupQueuedRunPassOutstanding(): boolean {
  return phase !== "ready" || queuedRunPassPending;
}

export function resetStartupRecoveryStateForTests(): void {
  phase = "ready";
  updatedAt = new Date().toISOString();
  queuedRunPassPending = false;
}
