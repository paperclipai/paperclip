export type StartupRecoveryPhase = "starting" | "recovering" | "ready";

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
  phase = "ready";
  updatedAt = new Date().toISOString();
}
