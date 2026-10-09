/** Personal inbox routing; company-wide run visibility is unchanged. */
export function isHeartbeatRunVisibleInMine(
  run: { responsibleUserId?: string | null },
  currentUserId: string | null | undefined,
): boolean {
  if (!currentUserId) return false;
  if (run.responsibleUserId) return run.responsibleUserId === currentUserId;
  // Preserve unattributed historical runs for the single-user local board.
  return currentUserId === "local-board";
}
