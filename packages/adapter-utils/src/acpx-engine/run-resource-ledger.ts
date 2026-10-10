// The run resource ledger and the scoped cleanup registry.
//
// The ledger is the single owner of the run resources between acquisition and
// settlement. `register` is the only writer. `seal` ends acquisition and
// validates the required set. `takeForSettlement` makes the one-time claim that
// hands the resources to settlement. The state machine is `open -> sealed ->
// consumed` or `open -> consumed`.
//
// The scoped cleanup registry holds cleanup thunks by lifetime. The coordinator
// runs the `startup_rollback` scope when startup fails and the `per_run` scope
// at settlement. A successful seal promotes the rollback cleanups to per_run.

import { LedgerStateError } from "./run-contracts.js";
import type {
  AcquiredRunResources,
  CleanupScope,
  ConsumedRunResources,
  ReadyRunResources,
  ResourceDisposition,
  ResourceId,
  RunResourcePayloads,
  RunResourceRegistration,
  SettledResourceEntry,
} from "./run-contracts.js";

type LedgerState = "open" | "sealed" | "consumed";

interface LedgerSlot {
  readonly id: ResourceId;
  readonly payload: RunResourcePayloads[ResourceId];
  scope: CleanupScope;
  readonly promotable: boolean;
  readonly onDisposition?: (disposition: ResourceDisposition) => void;
}

/**
 * Create a run resource ledger. The ledger starts `open`. `register` fills at
 * most one slot per resource id. `seal` validates the required set and promotes
 * promotable `startup_rollback` entries to `per_run`. `takeForSettlement` makes
 * the one-time settlement claim.
 */
export function createRunResourceLedger(): AcquiredRunResources {
  const slots = new Map<ResourceId, LedgerSlot>();
  let state: LedgerState = "open";
  let sealedRequired: readonly ResourceId[] = [];

  function readyView(): ReadyRunResources {
    const view = {
      get(id: ResourceId): RunResourcePayloads[ResourceId] | undefined {
        return slots.get(id)?.payload;
      },
      scopeOf(id: ResourceId): CleanupScope | undefined {
        return slots.get(id)?.scope;
      },
      has(id: ResourceId): boolean {
        return slots.has(id);
      },
      sealed: sealedRequired,
    };
    return view as unknown as ReadyRunResources;
  }

  return {
    register(registration: RunResourceRegistration): void {
      if (state !== "open") {
        throw new LedgerStateError(
          state === "sealed"
            ? "cannot register a resource after the ledger is sealed"
            : "cannot register a resource after the ledger is taken for settlement",
        );
      }
      if (slots.has(registration.id)) {
        throw new LedgerStateError(`resource slot "${registration.id}" is already filled`);
      }
      slots.set(registration.id, {
        id: registration.id,
        payload: registration.payload,
        scope: registration.scope,
        promotable: registration.promotable ?? true,
        onDisposition: registration.onDisposition,
      });
    },

    seal(required: readonly ResourceId[]): ReadyRunResources {
      if (state !== "open") {
        throw new LedgerStateError(
          state === "sealed"
            ? "the ledger is already sealed"
            : "cannot seal the ledger after it is taken for settlement",
        );
      }
      // Validate the required set first. A failed seal must leave the ledger
      // open and unchanged, so the caller can register the missing slot and
      // seal again.
      const missing = required.filter((id) => !slots.has(id));
      if (missing.length > 0) {
        throw new LedgerStateError(`seal is missing required resource(s): ${missing.join(", ")}`);
      }
      // Promote every promotable startup_rollback entry to per_run in one pass.
      // The resource now lives through the whole run, so settlement owns it.
      for (const slot of slots.values()) {
        if (slot.scope === "startup_rollback" && slot.promotable) {
          slot.scope = "per_run";
        }
      }
      state = "sealed";
      sealedRequired = [...required];
      return readyView();
    },

    takeForSettlement(): ConsumedRunResources {
      // The one-time claim. Check the state first, so a second claim throws
      // before it can mark a disposition or hand the resources out again.
      if (state === "consumed") {
        throw new LedgerStateError("run resources are already taken for settlement");
      }
      state = "consumed";
      const entries: SettledResourceEntry[] = [];
      for (const slot of slots.values()) {
        slot.onDisposition?.("transferred");
        entries.push({
          id: slot.id,
          payload: slot.payload,
          scope: slot.scope,
          disposition: "transferred",
        });
      }
      const consumed = { entries: () => entries };
      return consumed as unknown as ConsumedRunResources;
    },
  };
}

/**
 * A registry of cleanup thunks, grouped by lifetime scope. The coordinator adds
 * a cleanup under a scope, promotes a scope's cleanups to another scope, and
 * runs a scope's cleanups.
 */
export interface ScopedCleanupRegistry {
  /** Add a cleanup under a scope. */
  add(scope: CleanupScope, cleanup: () => void | Promise<void>): void;
  /** Move every cleanup from one scope to another, in registration order. */
  promote(from: CleanupScope, to: CleanupScope): void;
  /** The count of cleanups in a scope. */
  size(scope: CleanupScope): number;
  /**
   * Run and clear a scope's cleanups in reverse registration order. Run every
   * cleanup even when one fails. Throw an `AggregateError` at the end when one
   * or more failed, so no error is lost and no cleanup is skipped.
   */
  run(scope: CleanupScope): Promise<void>;
}

/** Create an empty scoped cleanup registry. */
export function createScopedCleanupRegistry(): ScopedCleanupRegistry {
  const byScope = new Map<CleanupScope, Array<() => void | Promise<void>>>();

  function bucket(scope: CleanupScope): Array<() => void | Promise<void>> {
    let list = byScope.get(scope);
    if (!list) {
      list = [];
      byScope.set(scope, list);
    }
    return list;
  }

  return {
    add(scope: CleanupScope, cleanup: () => void | Promise<void>): void {
      bucket(scope).push(cleanup);
    },

    promote(from: CleanupScope, to: CleanupScope): void {
      if (from === to) return;
      const source = byScope.get(from);
      if (!source || source.length === 0) return;
      const target = bucket(to);
      target.push(...source);
      byScope.set(from, []);
    },

    size(scope: CleanupScope): number {
      return byScope.get(scope)?.length ?? 0;
    },

    async run(scope: CleanupScope): Promise<void> {
      const list = byScope.get(scope) ?? [];
      byScope.set(scope, []);
      const errors: unknown[] = [];
      for (let index = list.length - 1; index >= 0; index -= 1) {
        try {
          await list[index]();
        } catch (err) {
          errors.push(err);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `cleanup scope "${scope}" had ${errors.length} failure(s)`);
      }
    },
  };
}
