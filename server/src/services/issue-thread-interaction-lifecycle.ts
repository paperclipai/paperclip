export function pendingInteractionTerminalConflict(
  currentStatus: string,
  requestedStatus: unknown,
  interactions: ReadonlyArray<{ status: string }>,
): string | null {
  const terminalRequested = requestedStatus === "done" || requestedStatus === "cancelled";
  const alreadyTerminal = currentStatus === "done" || currentStatus === "cancelled";
  if (!terminalRequested || alreadyTerminal) return null;

  const pendingCount = interactions.filter((interaction) => interaction.status === "pending").length;
  if (pendingCount === 0) return null;

  return pendingCount === 1
    ? "Resolve or expire the pending decision before closing this task."
    : `Resolve or expire the ${pendingCount} pending decisions before closing this task.`;
}
