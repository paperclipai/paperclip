import type { heartbeatService } from "./heartbeat.js";

export type IssueActiveRunLookup = Pick<
  ReturnType<typeof heartbeatService>,
  "getRun" | "getRunIssueControl" | "getActiveRunForAgent" | "getActiveRunIssueControlForAgent"
>;

export async function resolveActiveIssueRunFor(
  heartbeat: IssueActiveRunLookup,
  issue: {
    id: string;
    assigneeAgentId: string | null;
    executionRunId?: string | null;
  },
  options?: { queueStateOnly: true },
) {
  let runToInterrupt = issue.executionRunId
    ? options?.queueStateOnly
      ? await heartbeat.getRunIssueControl(issue.executionRunId)
      : await heartbeat.getRun(issue.executionRunId)
    : null;

  if (
    (!runToInterrupt || runToInterrupt.status !== "running") &&
    issue.assigneeAgentId
  ) {
    const activeRun = options?.queueStateOnly
      ? await heartbeat.getActiveRunIssueControlForAgent(issue.assigneeAgentId)
      : await heartbeat.getActiveRunForAgent(issue.assigneeAgentId);
    const activeIssueId =
      activeRun &&
      activeRun.contextSnapshot &&
      typeof activeRun.contextSnapshot === "object" &&
      typeof (activeRun.contextSnapshot as Record<string, unknown>)
        .issueId === "string"
        ? ((activeRun.contextSnapshot as Record<string, unknown>)
            .issueId as string)
        : null;
    if (
      activeRun &&
      activeRun.status === "running" &&
      activeIssueId === issue.id
    ) {
      runToInterrupt = activeRun;
    }
  }

  return runToInterrupt?.status === "running" ? runToInterrupt : null;
}
