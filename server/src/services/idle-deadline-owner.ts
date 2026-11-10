import type { Db } from "@paperclipai/db";
import type { DeadlineReconciliationSnapshot } from "./deadline-reconciliation.js";
import type { IdleDeadlineOwnerInspection, IdleDeadlineOwnerReader, IdleDeadlineSnapshot } from "./idle-deadline-types.js";

export function bindIdleDeadlineOwner<T extends IdleDeadlineSnapshot>(
  owner: () => DeadlineReconciliationSnapshot,
  read: (tx: Pick<Db, "select" | "execute">, now: number, owner: () => DeadlineReconciliationSnapshot,
    checkBudget: () => void) => Promise<T>,
  coverage: (snapshot: T) => Pick<IdleDeadlineOwnerInspection, "coverage" | "issueWaits"> = () => ({}),
): IdleDeadlineOwnerReader {
  return async (tx, now, checkBudget) => {
    const before = owner();
    const snapshot = await read(tx, now, owner, checkBudget);
    return { snapshot, ...(snapshot.blocked ? {} : coverage(snapshot)), current: () => {
      const after = owner();
      return before.reconciled && after.reconciled && before.revision === after.revision;
    } };
  };
}
