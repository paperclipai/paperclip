/**
 * Phase 4A-1 (LET-310): sandbox lease lifecycle state machine.
 *
 * Tracks the in-memory lifecycle for a sandbox lease independent of the
 * `environment_leases.status` column. The DB column is a coarse external
 * status (active|released|expired|failed|retained); this state machine
 * adds the fine-grained provisioning/collecting/cleanup states the Docker
 * provider needs to coordinate with the reaper without a real Docker call.
 */

export const SANDBOX_LEASE_STATES = [
  "requested",
  "provisioning",
  "running",
  "collecting",
  "cleanup",
  "expired",
  "failed",
] as const;

export type SandboxLeaseState = (typeof SANDBOX_LEASE_STATES)[number];

export const TERMINAL_SANDBOX_LEASE_STATES: ReadonlySet<SandboxLeaseState> = new Set([
  "expired",
  "failed",
]);

const ALLOWED_TRANSITIONS: Record<SandboxLeaseState, ReadonlySet<SandboxLeaseState>> = {
  requested: new Set(["provisioning", "failed"]),
  provisioning: new Set(["running", "cleanup", "failed"]),
  running: new Set(["collecting", "cleanup", "failed", "expired"]),
  collecting: new Set(["cleanup", "failed", "expired"]),
  cleanup: new Set(["expired", "failed"]),
  expired: new Set<SandboxLeaseState>(),
  failed: new Set<SandboxLeaseState>(),
};

export function isTerminalSandboxLeaseState(state: SandboxLeaseState): boolean {
  return TERMINAL_SANDBOX_LEASE_STATES.has(state);
}

export function canTransitionSandboxLease(
  from: SandboxLeaseState,
  to: SandboxLeaseState,
): boolean {
  if (from === to) return false;
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

export class IllegalSandboxLeaseTransitionError extends Error {
  readonly code = "ILLEGAL_SANDBOX_LEASE_TRANSITION";
  constructor(
    readonly from: SandboxLeaseState,
    readonly to: SandboxLeaseState,
  ) {
    super(`Illegal sandbox lease transition: ${from} -> ${to}`);
  }
}

export function assertSandboxLeaseTransition(
  from: SandboxLeaseState,
  to: SandboxLeaseState,
): void {
  if (!canTransitionSandboxLease(from, to)) {
    throw new IllegalSandboxLeaseTransitionError(from, to);
  }
}

export function listAllowedSandboxLeaseTransitions(
  from: SandboxLeaseState,
): SandboxLeaseState[] {
  return [...(ALLOWED_TRANSITIONS[from] ?? new Set())];
}
