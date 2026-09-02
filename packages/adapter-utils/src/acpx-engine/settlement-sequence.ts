// The settlement sequence.
//
// `settleAcpRun(ledger, cause, steps)` is the one cleanup owner for every site
// and every settled path. The one exception is the startup rollback, which the
// coordinator owns (Phase 20).
//
// The sequence claims the ledger once, makes the pure reuse decision, then runs
// the ordered steps:
//
//   1. endSession   — close every runtime the decision did not transfer, and
//                     drop the warm entry when it closes.
//   2. settleReuse  — perform the decision: a save transfers the candidate to the
//                     site store (which arms the per-entry idle timer); everything
//                     else discards.
//   3. stopTransport — stop both bridges in one `allSettled`.
//   4. syncBack     — the site sync-back.
//   5. releaseStagingLease — runs in a `finally`, so an earlier step fault never
//                     strands the lease.
//
// The Phase 3 error policy governs every step: a step records its error and the
// later steps still run. Every step no-ops on an empty slot.
//
// Amendment B — the credential gate. A runtime is save-eligible only when no
// run-scoped credential issued to it remains valid. The decision is pure and
// runs before any close. Settlement stops both bridges before a sandbox-lane
// transfer, so the bridge tokens die with the bridges. The run API key is not
// invalidated on run end (grounded server-side), so the host-lane warm save
// discards instead of transfers (close-and-relaunch) until a credential-rebind
// protocol exists. The sandbox staged-files reuse is unaffected: its payload
// carries no credentials.

import type {
  AcquiredRunResources,
  ResourceDisposition,
  ResourceId,
  RunResourcePayloads,
  RunSiteKind,
  SettledResourceEntry,
  SettlementCause,
} from "./run-contracts.js";

/** The save-versus-discard decision the settlement makes before any close. */
export type ReuseDecision =
  | { readonly kind: "save"; readonly savedId: ResourceId }
  | { readonly kind: "discard"; readonly reason: string };

/**
 * The inputs the reuse decision reads. The site derives the candidate from the
 * settled slots. A null candidate means the run holds nothing to save.
 */
export interface ReuseCandidateInput {
  /** The site kind. "host" saves the runtime; "sandbox" saves the staged files. */
  readonly kind: RunSiteKind;
  /** True when the settlement cause permits a save (a clean persistent turn). */
  readonly causePermitsSave: boolean;
  /**
   * Amendment B: the run-scoped credentials the candidate would still carry into
   * the store. A save is eligible only when this list is empty — no run-scoped
   * credential issued to the runtime remains valid.
   */
  readonly liveRunScopedCredentials: readonly string[];
}

/** One resource's final disposition, as the settlement records it. */
export interface ResourceDispositionRecord {
  readonly id: ResourceId;
  readonly disposition: ResourceDisposition;
}

/** The per-resource disposition report the settlement produces at the end. */
export interface SettlementDispositionReport {
  readonly records: readonly ResourceDispositionRecord[];
}

/** The settled slots view a step reads. `get` returns undefined for an empty slot. */
export interface SettlementSlots {
  get<Id extends ResourceId>(id: Id): RunResourcePayloads[Id] | undefined;
  has(id: ResourceId): boolean;
}

/**
 * The effectful steps the sequence runs. The engine implements each step over
 * its own run state. Each step no-ops on an empty slot. A step must not throw
 * for the sequence to record its error and continue; a throw is caught and
 * recorded under the Phase 3 error policy.
 */
export interface SettlementSteps {
  /**
   * Derive the reuse candidate from the settled slots and the cause, or null
   * when the run holds nothing to save.
   */
  reuseCandidate(slots: SettlementSlots, cause: SettlementCause | null): ReuseCandidateInput | null;
  /** Close every runtime the decision did not transfer; drop the warm entry on close. */
  endSession(slots: SettlementSlots, decision: ReuseDecision): Promise<void> | void;
  /** Perform the decision: a save transfers to the site store; everything else discards. */
  settleReuse(slots: SettlementSlots, decision: ReuseDecision): Promise<void> | void;
  /** Stop both bridges in one `allSettled`. */
  stopTransport(slots: SettlementSlots): Promise<void> | void;
  /** The site sync-back. */
  syncBack(slots: SettlementSlots): Promise<void> | void;
  /** Release the staging lease. Runs in a `finally`. */
  releaseStagingLease(slots: SettlementSlots): void;
  /** Record a per-step error under the Phase 3 error policy. */
  recordError(step: string, error: unknown): Promise<void> | void;
}

/**
 * The pure reuse decision. A save is eligible only when a candidate exists, the
 * cause permits a save, and Amendment B holds: no run-scoped credential issued
 * to the candidate remains valid. Everything else discards, with a reason.
 */
export function decideReuse(candidate: ReuseCandidateInput | null): ReuseDecision {
  if (!candidate) {
    return { kind: "discard", reason: "no reuse candidate" };
  }
  if (!candidate.causePermitsSave) {
    return { kind: "discard", reason: "settlement cause forbids save" };
  }
  if (candidate.liveRunScopedCredentials.length > 0) {
    // Amendment B credential gate: a live run-scoped credential blocks the save.
    return { kind: "discard", reason: "run-scoped credential still valid" };
  }
  const savedId: ResourceId = candidate.kind === "host" ? "acp_runtime" : "staged_runtime";
  return { kind: "save", savedId };
}

/**
 * Settle the run's resources. Claims the ledger once, makes the reuse decision,
 * runs the ordered steps under the Phase 3 error policy, releases the staging
 * lease in a `finally`, and returns the final per-resource disposition report.
 */
export async function settleAcpRun(
  ledger: AcquiredRunResources,
  cause: SettlementCause | null,
  steps: SettlementSteps,
): Promise<SettlementDispositionReport> {
  // Claim the ledger once. Every later step reads the claimed slots.
  const consumed = ledger.takeForSettlement();
  const entries = consumed.entries();
  const slots = makeSlots(entries);

  // The reuse decision is pure and runs before any close.
  const candidate = steps.reuseCandidate(slots, cause);
  const decision = decideReuse(candidate);

  const runStep = async (name: string, run: () => Promise<void> | void): Promise<void> => {
    try {
      await run();
    } catch (error) {
      // The Phase 3 error policy: record the step error and let later steps run.
      await steps.recordError(name, error);
    }
  };

  try {
    await runStep("end_session", () => steps.endSession(slots, decision));
    await runStep("settle_reuse", () => steps.settleReuse(slots, decision));
    await runStep("stop_transport", () => steps.stopTransport(slots));
    await runStep("sync_back", () => steps.syncBack(slots));
  } finally {
    // The staging lease release runs in a `finally`, so an earlier step fault
    // never strands the lease.
    try {
      steps.releaseStagingLease(slots);
    } catch (error) {
      await steps.recordError("release_staging_lease", error);
    }
  }

  return buildReport(entries, decision);
}

/** Build the settled slots view from the claimed entries. */
function makeSlots(entries: readonly SettledResourceEntry[]): SettlementSlots {
  const byId = new Map<ResourceId, SettledResourceEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  return {
    get<Id extends ResourceId>(id: Id): RunResourcePayloads[Id] | undefined {
      return byId.get(id)?.payload as RunResourcePayloads[Id] | undefined;
    },
    has(id: ResourceId): boolean {
      return byId.has(id);
    },
  };
}

/**
 * Build the final per-resource disposition report. The claim-time value the
 * ledger stamps ("transferred") is not the final report; the settlement decides
 * it here. A saved resource is `transferred`; every other resource is
 * `finalized`.
 */
function buildReport(
  entries: readonly SettledResourceEntry[],
  decision: ReuseDecision,
): SettlementDispositionReport {
  const savedId = decision.kind === "save" ? decision.savedId : null;
  return {
    records: entries.map((entry) => ({
      id: entry.id,
      disposition: entry.id === savedId ? ("transferred" as const) : ("finalized" as const),
    })),
  };
}
