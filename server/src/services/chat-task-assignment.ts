/** Use the same effective assignee for authorization and persisted chat handoffs. */
export function resolveChatTaskAssignment(
  assignment: { assigneeAgentId?: string | null; assigneeUserId?: string | null },
  conversationAgentId: string | null | undefined,
) {
  return {
    assigneeAgentId: assignment.assigneeAgentId
      ?? (assignment.assigneeUserId ? null : conversationAgentId ?? null),
    assigneeUserId: assignment.assigneeUserId ?? null,
  };
}
