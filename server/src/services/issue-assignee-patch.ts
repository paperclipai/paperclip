type AssigneePatch = {
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
};

export function normalizeExclusiveAssigneePatch<T extends AssigneePatch>(patch: T): T {
  if (patch.assigneeAgentId !== undefined && patch.assigneeAgentId !== null && patch.assigneeUserId === undefined) {
    return { ...patch, assigneeUserId: null };
  }
  if (patch.assigneeUserId !== undefined && patch.assigneeUserId !== null && patch.assigneeAgentId === undefined) {
    return { ...patch, assigneeAgentId: null };
  }
  return patch;
}
