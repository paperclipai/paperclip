import type { IssueSummary } from "@paperclipai/shared";
import type { LiveRunForIssue } from "../../api/heartbeats";
export interface ChartTask { id: string; title: string; identifier: string | null; agentIds: string[]; ownerId: string }
/** Only actual running executions create associations. No inference from reporting lines. */
export function collectChartTasks(runs: LiveRunForIssue[], summaries: IssueSummary[], agentIds: ReadonlySet<string>): ChartTask[] {
  const names = new Map(summaries.map(task => [task.id, task]));
  const associations = new Map<string, Set<string>>();
  for (const run of runs) {
    if (run.status !== "running" || !run.issueId || !agentIds.has(run.agentId)) continue;
    const ids = associations.get(run.issueId) ?? new Set<string>();
    ids.add(run.agentId); associations.set(run.issueId, ids);
  }
  return [...associations].sort(([a], [b]) => a.localeCompare(b)).map(([id, agents]) => {
    const task = names.get(id), ids = [...agents].sort();
    return { id, title: task?.title ?? "Running task", identifier: task?.identifier ?? null, agentIds: ids, ownerId: ids[0] };
  });
}
