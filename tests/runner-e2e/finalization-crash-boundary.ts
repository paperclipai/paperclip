export interface FinalizationCrashBinding {
  companyId: string;
  issueId: string;
  runId: string;
}

type Row = Record<string, unknown>;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function parseFinalizationCrashBinding(value: unknown): FinalizationCrashBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid finalization crash binding");
  const row = value as Row;
  if (Object.keys(row).length !== 3 || !["companyId", "issueId", "runId"].every(key => typeof row[key] === "string" && uuid.test(row[key] as string)))
    throw new Error("Invalid finalization crash binding");
  return { companyId: row.companyId as string, issueId: row.issueId as string, runId: row.runId as string };
}

export async function readFinalizationCrashBoundary(
  read: (path: string) => Promise<unknown>,
  binding: FinalizationCrashBinding,
) {
  const [run, issue] = await Promise.all([
    read(`/api/heartbeat-runs/${binding.runId}`),
    read(`/api/issues/${binding.issueId}`),
  ]) as [Row, Row];
  if (!run || !issue || run.id !== binding.runId || run.companyId !== binding.companyId ||
      run.nativeIssueId !== binding.issueId || run.runtimeMode !== "native" || run.status !== "running" ||
      run.nativePhase !== "workspace_finalizing" || issue.id !== binding.issueId || issue.companyId !== binding.companyId ||
      issue.executionRunId !== binding.runId || issue.assigneeAgentId !== run.agentId ||
      ["done", "cancelled", "blocked"].includes(String(issue.status)))
    throw new Error("The bound native result is not awaiting workspace finalization; crash boundary was not exercised");
  return { ...binding, nativePhase: "workspace_finalizing" as const, observedAt: new Date().toISOString() };
}
