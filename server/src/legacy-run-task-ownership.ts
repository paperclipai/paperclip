import { forbidden } from "./errors.js";

export function assertLegacyRunTaskOwnership(
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
  if (run?.runtimeMode === "legacy" && run.companyId === issue.companyId &&
      run.contextSnapshot?.issueId === issue.id &&
      issue.assigneeAgentId === null && issue.assigneeUserId) {
    throw forbidden("This task is assigned to a human; the outgoing run can no longer change it", {
      code: "issue_handed_off",
      issueId: issue.id,
    });
  }
}
