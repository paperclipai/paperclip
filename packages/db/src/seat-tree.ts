export const MAX_SEAT_TREE_DEPTH = 256;

export function assertNoSeatCycle(input: {
  seatId: string;
  proposedParentSeatId: string | null;
  parentSeatIdBySeatId: ReadonlyMap<string, string | null | undefined>;
  maxDepth?: number;
}) {
  const { seatId, proposedParentSeatId, parentSeatIdBySeatId, maxDepth = MAX_SEAT_TREE_DEPTH } = input;
  if (!proposedParentSeatId) return;
  if (proposedParentSeatId === seatId) {
    throw new Error("Seat hierarchy would create cycle");
  }

  let cursor: string | null = proposedParentSeatId;
  const visited = new Set<string>();
  let depth = 0;

  while (cursor) {
    depth += 1;
    if (depth > maxDepth) {
      throw new Error(`Seat hierarchy exceeds maximum depth of ${maxDepth}`);
    }
    if (cursor === seatId || visited.has(cursor)) {
      throw new Error("Seat hierarchy would create cycle");
    }
    visited.add(cursor);
    cursor = parentSeatIdBySeatId.get(cursor) ?? null;
  }
}
