import { forbidden } from "./errors.js";

/**
 * A run that handed its own task to a person keeps running to finish its turn,
 * but it no longer owns the task. Reject its later task mutations, legacy or
 * native, so the person's task cannot be changed by the outgoing run.
 */
export function assertHandedOffRunTaskOwnership(
  run: {
    companyId: string;
    runtimeMode: string;
    contextSnapshot?: Record<string, unknown> | null;
  } | null | undefined,
  issue: {
    id: string;
    companyId: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
  },
) {
  if ((run?.runtimeMode === "legacy" || run?.runtimeMode === "native") && run.companyId === issue.companyId &&
      run.contextSnapshot?.issueId === issue.id &&
      issue.assigneeAgentId === null && issue.assigneeUserId) {
    throw forbidden("This task is assigned to a human; the outgoing run can no longer change it", {
      code: "issue_handed_off",
      issueId: issue.id,
    });
  }
}
