export interface InboxTaskEvidence {
  id: string; companyId: string; assigneeUserId: string | null; assigneeAgentId: string | null;
  status: string; isUnreadForMe?: boolean; archivedAt?: string | null;
}

export function inboxTaskMatches(task: InboxTaskEvidence | undefined,
  expected: { id: string; companyId: string; userId: string; status: string }): boolean {
  return Boolean(task && task.id === expected.id && task.companyId === expected.companyId
    && task.assigneeUserId === expected.userId && task.assigneeAgentId === null && task.status === expected.status);
}

export function inboxArchivePersisted(task: InboxTaskEvidence | undefined,
  expected: { id: string; companyId: string; userId: string; status: string }, visible: InboxTaskEvidence[]): boolean {
  return inboxTaskMatches(task, expected) && typeof task!.archivedAt === "string"
    && Number.isFinite(Date.parse(task!.archivedAt)) && !visible.some(row => row.id === expected.id);
}

export function inboxTaskResurfaced(task: InboxTaskEvidence | undefined,
  expected: { id: string; companyId: string; userId: string; status: string }, visible: InboxTaskEvidence[]): boolean {
  const matches = visible.filter(row => row.id === expected.id);
  return inboxTaskMatches(task, expected) && task!.archivedAt == null && matches.length === 1
    && inboxTaskMatches(matches[0], expected) && matches[0]!.archivedAt == null;
}
