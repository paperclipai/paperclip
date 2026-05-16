/**
 * Phase 4A-1 (LET-310): idempotent sandbox lease reaper.
 *
 * Inspects lease rows and decides whether the row should be marked for
 * cleanup. Does NOT touch the host or run docker commands — Phase 4A-1
 * records intended audit hooks only. Real cleanup will be wired in a
 * later child after the boundary work in Phase 4A-2/3.
 */

import { isTerminalSandboxLeaseState, type SandboxLeaseState } from "./lease-state-machine.js";

export interface SandboxReaperLeaseRow {
  id: string;
  status: "active" | "released" | "expired" | "failed" | "retained";
  providerLeaseId: string | null;
  acquiredAt: Date;
  lastUsedAt: Date;
  expiresAt: Date | null;
  releasedAt: Date | null;
  /** Optional fine-grained sandbox state, if recorded in metadata. */
  sandboxState?: SandboxLeaseState | null;
}

export type SandboxReaperDecisionKind =
  | "skip_terminal"
  | "skip_active"
  | "skip_orphan_no_provider_lease"
  | "mark_expired_idle"
  | "mark_expired_walltime";

export interface SandboxReaperDecision {
  leaseId: string;
  decision: SandboxReaperDecisionKind;
  reason: string;
}

export interface SandboxReaperOptions {
  /** "Now" reference, injected for test determinism. */
  now: Date;
  /** Idle deadline in ms past `lastUsedAt` after which a lease may be reaped. */
  idleTimeoutMs: number;
}

export const DEFAULT_SANDBOX_REAPER_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Pure decision function. Idempotent: re-running over the same row returns
 * the same decision. Terminal rows are skipped (skip_terminal). Orphan rows
 * that never reached a provider lease are skipped without destructive action.
 */
export function decideSandboxLeaseReap(
  row: SandboxReaperLeaseRow,
  options: SandboxReaperOptions,
): SandboxReaperDecision {
  if (row.status === "expired" || row.status === "failed" || row.status === "released") {
    return {
      leaseId: row.id,
      decision: "skip_terminal",
      reason: `lease already in terminal status "${row.status}"`,
    };
  }
  if (row.sandboxState && isTerminalSandboxLeaseState(row.sandboxState)) {
    return {
      leaseId: row.id,
      decision: "skip_terminal",
      reason: `lease already in terminal sandbox state "${row.sandboxState}"`,
    };
  }
  if (row.providerLeaseId === null) {
    return {
      leaseId: row.id,
      decision: "skip_orphan_no_provider_lease",
      reason: "lease never acquired a provider id; not eligible for host cleanup",
    };
  }
  if (row.expiresAt && row.expiresAt.getTime() <= options.now.getTime()) {
    return {
      leaseId: row.id,
      decision: "mark_expired_walltime",
      reason: `expiresAt ${row.expiresAt.toISOString()} <= now`,
    };
  }
  const idleSinceMs = options.now.getTime() - row.lastUsedAt.getTime();
  if (idleSinceMs >= options.idleTimeoutMs) {
    return {
      leaseId: row.id,
      decision: "mark_expired_idle",
      reason: `idle for ${idleSinceMs}ms (>= ${options.idleTimeoutMs}ms)`,
    };
  }
  return {
    leaseId: row.id,
    decision: "skip_active",
    reason: "lease is active and within idle window",
  };
}

export function decideSandboxLeaseReapBatch(
  rows: ReadonlyArray<SandboxReaperLeaseRow>,
  options: SandboxReaperOptions,
): SandboxReaperDecision[] {
  return rows.map((row) => decideSandboxLeaseReap(row, options));
}
