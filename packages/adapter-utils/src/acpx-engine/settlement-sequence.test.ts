import { describe, expect, it } from "vitest";
import {
  decideReuse,
  settleAcpRun,
  type ReuseCandidateInput,
  type ReuseDecision,
  type SettlementSlots,
  type SettlementSteps,
} from "./settlement-sequence.js";
import { createRunResourceLedger } from "./run-resource-ledger.js";
import type { AcquiredRunResources, ResourceId, SettlementCause } from "./run-contracts.js";

// The settlement sequence is the one cleanup owner. These tests drive it with
// fakes for the steps and assert the claim, the order, the Phase 3 error policy,
// the staging-lease finally, and the Amendment B credential gate. They never
// touch the engine's real run state.

// Register a per-run resource for each id, with an optional payload the steps
// read. The tests do not seal the ledger; `takeForSettlement` runs from `open`.
function ledgerWith(
  ids: readonly ResourceId[],
  payloads: Partial<Record<ResourceId, unknown>> = {},
): AcquiredRunResources {
  const ledger = createRunResourceLedger();
  const register = ledger.register as (registration: {
    id: ResourceId;
    payload: unknown;
    scope: "per_run";
  }) => void;
  for (const id of ids) {
    register({ id, payload: payloads[id] ?? {}, scope: "per_run" });
  }
  return ledger;
}

// Count the claims so a test proves the sequence claims the ledger once.
function countingLedger(inner: AcquiredRunResources): {
  ledger: AcquiredRunResources;
  claims: () => number;
} {
  let claims = 0;
  const ledger: AcquiredRunResources = {
    register: inner.register.bind(inner),
    seal: inner.seal.bind(inner),
    takeForSettlement: () => {
      claims += 1;
      return inner.takeForSettlement();
    },
  };
  return { ledger, claims: () => claims };
}

// A base set of steps whose bodies record their name. Each test overrides the
// steps it drives.
function baseSteps(order: string[], overrides: Partial<SettlementSteps> = {}): SettlementSteps {
  return {
    reuseCandidate: overrides.reuseCandidate ?? (() => null),
    endSession: overrides.endSession ?? (() => {
      order.push("end_session");
    }),
    settleReuse: overrides.settleReuse ?? (() => {
      order.push("settle_reuse");
    }),
    stopTransport: overrides.stopTransport ?? (() => {
      order.push("stop_transport");
    }),
    syncBack: overrides.syncBack ?? (() => {
      order.push("sync_back");
    }),
    releaseStagingLease: overrides.releaseStagingLease ?? (() => {
      order.push("release_staging_lease");
    }),
    recordError: overrides.recordError ?? (() => {}),
  };
}

const cleanTurnCause: SettlementCause | null = null;

describe("ACPX settlement sequence", () => {
  it("test_settlement_claims_ledger_once_then_runs_the_steps_in_order", async () => {
    const order: string[] = [];
    const { ledger, claims } = countingLedger(
      ledgerWith(["acp_runtime", "control_bridge", "agent_bridge", "staging_lease"]),
    );

    await settleAcpRun(ledger, cleanTurnCause, baseSteps(order));

    // The sequence claims the ledger exactly once.
    expect(claims()).toBe(1);
    // It runs the effect steps in the fixed order; the lease release runs last.
    expect(order).toEqual([
      "end_session",
      "settle_reuse",
      "stop_transport",
      "sync_back",
      "release_staging_lease",
    ]);
  });

  it("test_every_step_noops_on_empty_slot", async () => {
    const order: string[] = [];
    // An empty ledger: no slot holds a resource. Each step reads its slot and
    // no-ops when the slot is empty.
    const ledger = ledgerWith([]);
    const noopFor = (name: string, id: ResourceId) => (slots: SettlementSlots) => {
      order.push(slots.has(id) ? `${name}:work` : `${name}:noop`);
    };
    const steps = baseSteps(order, {
      endSession: noopFor("end_session", "acp_runtime"),
      settleReuse: noopFor("settle_reuse", "acp_runtime"),
      stopTransport: noopFor("stop_transport", "control_bridge"),
      syncBack: noopFor("sync_back", "staged_runtime"),
      releaseStagingLease: (slots) => {
        order.push(slots.has("staging_lease") ? "release_staging_lease:work" : "release_staging_lease:noop");
      },
    });

    const report = await settleAcpRun(ledger, cleanTurnCause, steps);

    // Every step saw an empty slot and no-opped.
    expect(order).toEqual([
      "end_session:noop",
      "settle_reuse:noop",
      "stop_transport:noop",
      "sync_back:noop",
      "release_staging_lease:noop",
    ]);
    // An empty ledger yields an empty disposition report.
    expect(report.records).toEqual([]);
  });

  it("test_transferred_runtime_is_never_closed_and_discarded_entry_is_finalized", async () => {
    const order: string[] = [];
    const ledger = ledgerWith(["acp_runtime", "staging_lease"], {
      acp_runtime: { runtime: {}, sessionHandle: {}, childProcessPid: null },
    });
    const steps = baseSteps(order, {
      // A clean host turn with no live run-scoped credential is save-eligible.
      reuseCandidate: (): ReuseCandidateInput => ({
        kind: "host",
        causePermitsSave: true,
        liveRunScopedCredentials: [],
      }),
      endSession: (_slots, decision) => {
        // The transferred runtime is never closed.
        order.push(decision.kind === "save" ? "kept" : "closed");
      },
      settleReuse: (_slots, decision) => {
        order.push(decision.kind === "save" ? "transferred" : "discarded");
      },
    });

    const report = await settleAcpRun(ledger, cleanTurnCause, steps);

    // The runtime transferred; it was never closed.
    expect(order).toContain("kept");
    expect(order).not.toContain("closed");
    expect(order).toContain("transferred");
    // The report marks the transferred runtime `transferred` and the discarded
    // staging lease `finalized`.
    expect(report.records).toEqual([
      { id: "acp_runtime", disposition: "transferred" },
      { id: "staging_lease", disposition: "finalized" },
    ]);
  });

  it("test_step_error_is_recorded_and_later_steps_still_run", async () => {
    const order: string[] = [];
    const recorded: string[] = [];
    const boom = new Error("end_session boom");
    const steps = baseSteps(order, {
      endSession: () => {
        throw boom;
      },
      recordError: (step, error) => {
        recorded.push(step);
        expect(error).toBe(boom);
      },
    });

    await settleAcpRun(ledgerWith(["acp_runtime", "staging_lease"]), cleanTurnCause, steps);

    // The failed step is recorded...
    expect(recorded).toContain("end_session");
    // ...and every later step still runs.
    expect(order).toEqual([
      "settle_reuse",
      "stop_transport",
      "sync_back",
      "release_staging_lease",
    ]);
  });

  it("test_staging_lease_release_runs_in_finally", async () => {
    const order: string[] = [];
    const recorded: string[] = [];
    const steps = baseSteps(order, {
      syncBack: () => {
        throw new Error("sync_back boom");
      },
      recordError: (step) => {
        recorded.push(step);
      },
    });

    await settleAcpRun(ledgerWith(["staging_lease"]), cleanTurnCause, steps);

    // The sync-back failure is recorded, and the lease release still runs.
    expect(recorded).toContain("sync_back");
    expect(order).toContain("release_staging_lease");
  });

  it("test_two_compatible_runs_do_not_share_run_scoped_credentials", async () => {
    // Two compatible runs each own their ledger, bridge token, and run API key.
    // Run B must never observe run A's run-scoped values.
    const observed: Array<{ run: string; token: unknown; credentials: readonly string[] }> = [];
    const settleRun = async (run: string, token: string, credential: string) => {
      const ledger = ledgerWith(["acp_runtime", "control_bridge"], {
        control_bridge: { token },
      });
      const steps = baseSteps([], {
        reuseCandidate: (): ReuseCandidateInput => ({
          kind: "host",
          causePermitsSave: true,
          liveRunScopedCredentials: [credential],
        }),
        stopTransport: (slots) => {
          const bridge = slots.get("control_bridge") as { token: unknown } | undefined;
          observed.push({ run, token: bridge?.token, credentials: [credential] });
        },
      });
      return settleAcpRun(ledger, cleanTurnCause, steps);
    };

    await settleRun("A", "token-A", "run-api-key-A");
    await settleRun("B", "token-B", "run-api-key-B");

    const runA = observed.find((o) => o.run === "A");
    const runB = observed.find((o) => o.run === "B");
    // Run B observed only its own bridge token and credential, never run A's.
    expect(runB?.token).toBe("token-B");
    expect(runB?.token).not.toBe(runA?.token);
    expect(runB?.credentials).not.toContain("run-api-key-A");
  });

  it("test_no_run_scoped_credential_appears_in_reuse_payload_or_telemetry", async () => {
    const runScopedCredential = "run-api-key-secret";
    let savedPayload: Record<string, unknown> | null = null;
    // A save-eligible sandbox candidate: the staged-files payload carries no
    // credential, and the bridge tokens already died with the bridges, so the
    // live run-scoped credential list is empty.
    const ledger = ledgerWith(["staged_runtime", "staging_lease"], {
      staged_runtime: { stagedRuntime: { files: ["a", "b"] } },
    });
    const steps = baseSteps([], {
      reuseCandidate: (): ReuseCandidateInput => ({
        kind: "sandbox",
        causePermitsSave: true,
        liveRunScopedCredentials: [],
      }),
      settleReuse: (slots, decision) => {
        if (decision.kind === "save") {
          const staged = slots.get("staged_runtime") as unknown as {
            stagedRuntime: Record<string, unknown>;
          };
          savedPayload = staged.stagedRuntime;
        }
      },
    });

    const report = await settleAcpRun(ledger, cleanTurnCause, steps);

    // The saved reuse payload carries no run-scoped credential.
    expect(savedPayload).not.toBeNull();
    expect(JSON.stringify(savedPayload)).not.toContain(runScopedCredential);
    // The disposition report (telemetry) carries no run-scoped credential.
    expect(JSON.stringify(report)).not.toContain(runScopedCredential);
    // The staged files transferred.
    expect(report.records).toContainEqual({ id: "staged_runtime", disposition: "transferred" });
  });

  it("test_warm_save_requires_credential_gate_pass_else_close_and_relaunch", async () => {
    const runWithCredentials = async (liveRunScopedCredentials: readonly string[]) => {
      const order: string[] = [];
      const ledger = ledgerWith(["acp_runtime"]);
      const steps = baseSteps(order, {
        reuseCandidate: (): ReuseCandidateInput => ({
          kind: "host",
          causePermitsSave: true,
          liveRunScopedCredentials,
        }),
        endSession: (_slots, decision) => {
          order.push(decision.kind === "save" ? "kept" : "closed");
        },
      });
      const report = await settleAcpRun(ledger, cleanTurnCause, steps);
      return { order, report };
    };

    // A live run-scoped credential fails the gate: close-and-relaunch, finalized.
    const gated = await runWithCredentials(["run-api-key"]);
    expect(gated.order).toContain("closed");
    expect(gated.report.records).toContainEqual({ id: "acp_runtime", disposition: "finalized" });

    // No live run-scoped credential passes the gate: the runtime transfers.
    const cleared = await runWithCredentials([]);
    expect(cleared.order).toContain("kept");
    expect(cleared.report.records).toContainEqual({ id: "acp_runtime", disposition: "transferred" });
  });

  it("decideReuse blocks a save when the Amendment B credential gate fails", () => {
    // A direct unit check on the pure decision, so the gate is legible on its own.
    const base: ReuseCandidateInput = { kind: "host", causePermitsSave: true, liveRunScopedCredentials: [] };
    expect(decideReuse(base)).toEqual({ kind: "save", savedId: "acp_runtime" } satisfies ReuseDecision);
    expect(decideReuse({ ...base, liveRunScopedCredentials: ["k"] }).kind).toBe("discard");
    expect(decideReuse({ ...base, causePermitsSave: false }).kind).toBe("discard");
    expect(decideReuse(null).kind).toBe("discard");
    expect(decideReuse({ ...base, kind: "sandbox" })).toEqual({
      kind: "save",
      savedId: "staged_runtime",
    } satisfies ReuseDecision);
  });
});
