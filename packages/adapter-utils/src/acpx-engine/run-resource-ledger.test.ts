import { describe, expect, it, vi } from "vitest";
import { createRunResourceLedger, createScopedCleanupRegistry } from "./run-resource-ledger.js";
import { LedgerStateError } from "./run-contracts.js";
import type { RunResourcePayloads } from "./run-contracts.js";

// A typed placeholder payload for a resource whose value the test never reads.
function stub<T>(): T {
  return undefined as unknown as T;
}

describe("run resource ledger", () => {
  it("test_register_throws_on_filled_slot", () => {
    const ledger = createRunResourceLedger();
    ledger.register({ id: "staging_lease", scope: "per_run", payload: { release: () => {} } });

    expect(() =>
      ledger.register({ id: "staging_lease", scope: "per_run", payload: { release: () => {} } }),
    ).toThrow(LedgerStateError);
  });

  it("test_register_throws_after_seal_and_after_take", () => {
    const sealed = createRunResourceLedger();
    sealed.register({ id: "staging_lease", scope: "per_run", payload: { release: () => {} } });
    sealed.seal(["staging_lease"]);
    expect(() =>
      sealed.register({
        id: "managed_home",
        scope: "per_run",
        payload: stub<RunResourcePayloads["managed_home"]>(),
      }),
    ).toThrow(LedgerStateError);

    const taken = createRunResourceLedger();
    taken.register({ id: "staging_lease", scope: "per_run", payload: { release: () => {} } });
    taken.takeForSettlement();
    expect(() =>
      taken.register({
        id: "managed_home",
        scope: "per_run",
        payload: stub<RunResourcePayloads["managed_home"]>(),
      }),
    ).toThrow(LedgerStateError);
  });

  it("test_seal_validates_site_declared_required_slots", () => {
    const ledger = createRunResourceLedger();
    ledger.register({
      id: "acp_runtime",
      scope: "per_run",
      payload: stub<RunResourcePayloads["acp_runtime"]>(),
    });

    // The site declares control_bridge required, but it is not registered, so
    // seal throws and leaves the ledger open.
    expect(() => ledger.seal(["acp_runtime", "control_bridge"])).toThrow(LedgerStateError);

    // The failed seal left the ledger open, so the missing slot can be filled.
    ledger.register({
      id: "control_bridge",
      scope: "per_run",
      payload: stub<RunResourcePayloads["control_bridge"]>(),
    });
    const ready = ledger.seal(["acp_runtime", "control_bridge"]);

    expect(ready.has("acp_runtime")).toBe(true);
    expect(ready.has("control_bridge")).toBe(true);
    expect([...ready.sealed]).toEqual(["acp_runtime", "control_bridge"]);
  });

  it("test_seal_promotes_startup_rollback_entries_to_per_run", () => {
    const ledger = createRunResourceLedger();
    // Promotable by default.
    ledger.register({
      id: "staged_runtime",
      scope: "startup_rollback",
      payload: stub<RunResourcePayloads["staged_runtime"]>(),
    });
    // Pinned as rollback-only.
    ledger.register({
      id: "control_bridge",
      scope: "startup_rollback",
      promotable: false,
      payload: stub<RunResourcePayloads["control_bridge"]>(),
    });
    ledger.register({
      id: "acp_runtime",
      scope: "per_run",
      payload: stub<RunResourcePayloads["acp_runtime"]>(),
    });

    const ready = ledger.seal(["staged_runtime", "control_bridge", "acp_runtime"]);

    expect(ready.scopeOf("staged_runtime")).toBe("per_run");
    expect(ready.scopeOf("control_bridge")).toBe("startup_rollback");
    expect(ready.scopeOf("acp_runtime")).toBe("per_run");
  });

  it("test_take_for_settlement_is_synchronous_one_time_claim", () => {
    const ledger = createRunResourceLedger();
    ledger.register({
      id: "acp_runtime",
      scope: "per_run",
      payload: stub<RunResourcePayloads["acp_runtime"]>(),
    });

    const consumed = ledger.takeForSettlement();

    // Synchronous: the claim comes back directly, not as a promise.
    expect(consumed).not.toBeInstanceOf(Promise);
    expect(consumed.entries().map((entry) => entry.id)).toContain("acp_runtime");

    // One-time: a second claim throws.
    expect(() => ledger.takeForSettlement()).toThrow(LedgerStateError);
  });

  it("test_second_take_throws_ledger_state_error_before_any_side_effect", () => {
    const ledger = createRunResourceLedger();
    const onDisposition = vi.fn();
    ledger.register({
      id: "staging_lease",
      scope: "per_run",
      payload: { release: () => {} },
      onDisposition,
    });

    const first = ledger.takeForSettlement();
    expect(first.entries().map((entry) => entry.id)).toEqual(["staging_lease"]);
    expect(onDisposition).toHaveBeenCalledTimes(1);
    expect(onDisposition).toHaveBeenCalledWith("transferred");

    let thrown: unknown;
    try {
      ledger.takeForSettlement();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(LedgerStateError);
    // The second claim threw before it marked a disposition a second time.
    expect(onDisposition).toHaveBeenCalledTimes(1);
  });

  it("scoped cleanup registry runs and promotes cleanups by scope", async () => {
    const registry = createScopedCleanupRegistry();
    const order: string[] = [];
    registry.add("startup_rollback", () => {
      order.push("rollback-a");
    });
    registry.add("startup_rollback", async () => {
      order.push("rollback-b");
    });
    registry.add("per_run", () => {
      order.push("per-run");
    });
    expect(registry.size("startup_rollback")).toBe(2);

    registry.promote("startup_rollback", "per_run");
    expect(registry.size("startup_rollback")).toBe(0);
    expect(registry.size("per_run")).toBe(3);

    await registry.run("per_run");

    // Reverse registration order (last in, first out).
    expect(order).toEqual(["rollback-b", "rollback-a", "per-run"]);
    expect(registry.size("per_run")).toBe(0);
  });

  it("scoped cleanup registry runs every cleanup even when one fails", async () => {
    const registry = createScopedCleanupRegistry();
    const ran: string[] = [];
    registry.add("per_run", () => {
      ran.push("first");
    });
    registry.add("per_run", () => {
      throw new Error("boom");
    });
    registry.add("per_run", () => {
      ran.push("third");
    });

    await expect(registry.run("per_run")).rejects.toBeInstanceOf(AggregateError);
    // The failing cleanup did not skip the others.
    expect(ran).toEqual(["third", "first"]);
  });
});
