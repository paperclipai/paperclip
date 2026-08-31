export function shouldForwardOpenCodeProxyItem(input: {
  turnId?: string;
  kind?: unknown;
}): boolean {
  return !(input.turnId === undefined && input.kind === "model");
}

export function shouldAnnounceOpenCodeProxyTurn(
  announcedTurnIds: Set<string>,
  turnId: string,
): boolean {
  if (announcedTurnIds.has(turnId)) return false;
  announcedTurnIds.add(turnId);
  return true;
}
