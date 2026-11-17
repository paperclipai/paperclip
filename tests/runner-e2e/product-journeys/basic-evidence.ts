/** Independent saved-state oracle shared by attached and managed targets. */
export function questionEvidencePasses(input: {
  companyId: string; agentId: string; environmentId?: string; marker: string; model: string; provider: string; runtimeMode: string;
  issue: { id: string; companyId: string; workMode: string; status: string; assigneeAgentId: string | null };
  runs: Array<Record<string, any>>;
  comments: Array<{ authorAgentId?: string | null; body: string }>;
}) {
  const { issue, runs } = input;
  const run = runs[0];
  const provider = run?.runnerProfileJson?.nativeExecutionInput?.provider;
  return issue.companyId === input.companyId && issue.workMode === "ask" && issue.status === "done"
    && issue.assigneeAgentId === input.agentId && runs.length === 1
    && run?.companyId === input.companyId && run.agentId === input.agentId && run.issueId === issue.id
    && run.status === "succeeded" && run.runtimeMode === input.runtimeMode
    && input.runtimeMode === "native" && Boolean(input.environmentId && input.provider && input.model)
    && run.contextSnapshot?.paperclipEnvironment?.id === input.environmentId
    && provider?.kind === input.provider && provider?.model === input.model
    && input.comments.filter(comment => comment.authorAgentId === input.agentId && comment.body.trim() === input.marker).length === 1;
}
