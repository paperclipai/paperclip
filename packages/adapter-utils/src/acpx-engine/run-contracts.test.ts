// Compile-time type tests for the run contracts.
//
// The real assertion in each test is that this file compiles. A `@ts-expect-error`
// marks an assignment that MUST fail to typecheck; if it starts to compile, tsc
// reports the unused directive and the typecheck fails. The runtime body only
// keeps vitest happy, so each test names the property it proves.

import { describe, expect, it } from "vitest";
import type {
  AcquiredRunResources,
  ConsumedRunResources,
  PreTurnFailedCause,
  ReadyRunResources,
  SessionFingerprintIdentity,
  TurnCause,
} from "./run-contracts.js";

// A type-level equality check. `Equal<A, B>` is true only when A and B are the
// same type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

describe("run contracts", () => {
  it("test_a_turn_cause_is_not_assignable_where_pre_turn_failed_cause_is_required", () => {
    function requiresPreTurn(_cause: PreTurnFailedCause): void {}
    const turnCause: TurnCause = { kind: "turn_failed", error: new Error("boom") };

    // A turn cause has a different `kind` and no `phase`, so it is not
    // assignable where a `PreTurnFailedCause` is required.
    // @ts-expect-error a TurnCause is not a PreTurnFailedCause.
    requiresPreTurn(turnCause);

    expect(turnCause.kind).toBe("turn_failed");
  });

  it("test_only_seal_produces_ready_run_resources_and_only_take_for_settlement_produces_consumed_run_resources", () => {
    // The assertions live in an unexecuted function so tsc checks the types
    // without a runtime call on a synthetic ledger.
    function _assertBrands(ledger: AcquiredRunResources): void {
      // `seal()` is the only source of a `ReadyRunResources`;
      // `takeForSettlement()` is the only source of a `ConsumedRunResources`.
      const ready: ReadyRunResources = ledger.seal([]);
      const consumed: ConsumedRunResources = ledger.takeForSettlement();

      // The two brands are distinct: neither result is assignable to the other.
      // @ts-expect-error a ReadyRunResources is not a ConsumedRunResources.
      const _crossA: ConsumedRunResources = ready;
      // @ts-expect-error a ConsumedRunResources is not a ReadyRunResources.
      const _crossB: ReadyRunResources = consumed;

      // A plain object cannot stand in for a branded result; it lacks the
      // private brand that only `seal()` / `takeForSettlement()` can set.
      // @ts-expect-error missing the private ready brand.
      const _fakeReady: ReadyRunResources = {
        get: () => undefined,
        scopeOf: () => undefined,
        has: () => false,
        sealed: [],
      };
      // @ts-expect-error missing the private consumed brand.
      const _fakeConsumed: ConsumedRunResources = { entries: () => [] };

      void ready;
      void consumed;
      void _crossA;
      void _crossB;
      void _fakeReady;
      void _fakeConsumed;
    }

    void _assertBrands;
    expect(true).toBe(true);
  });

  it("test_session_fingerprint_identity_has_no_company_agent_or_task_member", () => {
    // None of the outer-key parts appear as a fingerprint field.
    type ForbiddenKey = "companyId" | "agentId" | "taskKey";
    type LeakedKey = Extract<keyof SessionFingerprintIdentity, ForbiddenKey>;
    type _noLeak = Expect<Equal<LeakedKey, never>>;

    const _ok: _noLeak = true;
    expect(_ok).toBe(true);
  });
});
