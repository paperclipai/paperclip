type IssueAssignmentBoundary = {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

export function isIssueUnassigned(issue: IssueAssignmentBoundary) {
  return issue.assigneeAgentId === null && issue.assigneeUserId === null;
}

export function canAgentMutateOrCheckoutIssue(issue: IssueAssignmentBoundary) {
  if (isIssueUnassigned(issue)) return true;
  if (issue.assigneeUserId !== null && issue.assigneeAgentId === null) return false;
  return true;
}
