import type { CompanyUserDirectoryEntry } from "../api/access";

const LOCAL_BOARD_USER_ID = "local-board";

export function humanAgentCreatorUserId(createdByUserId: string | null | undefined): string | null {
  return createdByUserId && createdByUserId !== LOCAL_BOARD_USER_ID ? createdByUserId : null;
}

export function resolveAgentCreatorLabel(
  createdByUserId: string | null | undefined,
  users: CompanyUserDirectoryEntry[] | undefined,
): string | null {
  const creatorUserId = humanAgentCreatorUserId(createdByUserId);
  if (!creatorUserId || !users) return null;
  const humans = users.filter((entry) => entry.principalId !== LOCAL_BOARD_USER_ID);
  if (humans.length < 2) return null;
  const creator = humans.find((entry) => entry.principalId === creatorUserId);
  if (!creator) return "Former member";
  return creator.user?.name?.trim() || creator.user?.email || "Unknown user";
}
