/** Origins that represent a person's ordinary task or onboarding request. */
export const HUMAN_TASK_ORIGIN_KINDS = ["manual", "onboarding_first_task"] as const;

export interface IssueCreationSourceFields {
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  originKind?: string | null;
}

/** Creation is independent of who is assigned or responsible for execution. */
export function isAgentCreatedIssue(issue: IssueCreationSourceFields): boolean {
  return Boolean(issue.createdByAgentId)
    || !issue.createdByUserId
    || !HUMAN_TASK_ORIGIN_KINDS.includes(
      (issue.originKind ?? "manual") as typeof HUMAN_TASK_ORIGIN_KINDS[number],
    );
}
