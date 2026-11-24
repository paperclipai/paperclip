import type { AttentionItem } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";

export function InboxProviderLimit({ item, evidence }: { item: AttentionItem; evidence: readonly AttentionItem[] }) {
  const members = [item, ...evidence].filter(member => member.providerLimit && member.relatedIssue);
  const tasks = [...new Map(members.map(member => [member.relatedIssue!.id, member])).values()];
  const manual = tasks.filter(task => task.providerLimit!.state === "needs_retry");
  const state = item.providerLimit!;
  const title = manual.length
    ? `${manual.length} ${manual.length === 1 ? "task needs" : "tasks need"} a retry after the usage limit`
    : `${tasks.length} ${tasks.length === 1 ? "task paused" : "tasks paused"} by the provider usage limit`;
  const taskLabel = (count: number) => count === 1 ? "task" : "tasks";
  const scheduled = tasks.filter(task => task.providerLimit!.state === "scheduled");
  return <div className="space-y-3">
    <h2>{title}</h2>
    {scheduled.length > 0 && state.resetAt && <p className="text-sm text-muted-foreground">Paperclip will retry {scheduled.length} {taskLabel(scheduled.length)} at <time dateTime={state.resetAt}>{new Date(state.resetAt).toLocaleString()}</time>.</p>}
    {!scheduled.length && !manual.length && <p className="text-sm text-muted-foreground">Retry requested. Waiting for work to resume.</p>}
    {manual.length > 0 && <p className="text-sm text-muted-foreground">Open the affected task to retry it when capacity is available.</p>}
    <details><summary className="cursor-pointer text-sm">View {tasks.length} {taskLabel(tasks.length)}</summary>
      <ul className="mt-2 space-y-2">{tasks.map(member => {
        const task = member.relatedIssue!;
        const limit = member.providerLimit!;
        return <li key={task.id} className="flex flex-wrap items-center gap-2 text-sm">
          <Link to={task.href!} className="underline">{task.identifier} {task.title}</Link>
          <span>{limit.agentName} · {limit.state === "needs_retry" ? "Needs retry" : limit.state === "scheduled" ? "Retry scheduled" : "Retry requested"}</span>
          <Link to={`/agents/${limit.agentId}/runs/${limit.runId}`} className="underline">Run log</Link>
        </li>;
      })}</ul>
    </details>
    {manual.length === 1 && <Button size="sm" asChild><Link to={manual[0]!.relatedIssue!.href!}>Open task to retry</Link></Button>}
  </div>;
}
