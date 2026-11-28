export interface ActiveRunSlotBounds {
  runsPerSlot: number;
  floor: number;
  ceiling: number;
}

export function assertActiveRunSlotBounds(bounds: ActiveRunSlotBounds): ActiveRunSlotBounds {
  const { runsPerSlot, floor, ceiling } = bounds;
  if (!Number.isSafeInteger(runsPerSlot) || runsPerSlot < 1
    || !Number.isSafeInteger(floor) || floor < 1
    || !Number.isSafeInteger(ceiling) || ceiling < floor) {
    throw new Error("invalid_active_run_slot_bounds");
  }
  return bounds;
}

export function slotsForActiveRuns(activeRuns: number, bounds: ActiveRunSlotBounds): number {
  const runs = Number.isFinite(activeRuns) && activeRuns > 0 ? Math.floor(activeRuns) : 0;
  return Math.min(bounds.ceiling, Math.max(bounds.floor, Math.ceil(runs / bounds.runsPerSlot)));
}
