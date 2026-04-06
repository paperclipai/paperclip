import type { GoalSnapshot } from "@ironworksai/shared";
import { api } from "./client";

/** Snapshot with budgetSpentCents serialized as string (bigint cannot be JSON). */
export type GoalSnapshotDTO = Omit<GoalSnapshot, "budgetSpentCents"> & {
  budgetSpentCents: string | null;
};

export const goalSnapshotsApi = {
  list: (companyId: string, goalId: string, days = 30) =>
    api.get<GoalSnapshotDTO[]>(
      `/companies/${encodeURIComponent(companyId)}/goals/${encodeURIComponent(goalId)}/snapshots?days=${days}`,
    ),
};
