import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { attentionApi } from "@/api/attention";
import { useCompany } from "@/context/CompanyContext";
import { coordinatorAttentionQueryKey, pendingDecisionTaskIds } from "@/lib/coordinator-attention";
import { useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { StatusIcon } from "@/components/StatusIcon";
import { ToolbarSearch } from "@/components/ToolbarSearch";

/** Distinct tasks from Needs You, not a second status-based attention guess. */
export function CoordinatorAttentionTasks({ toolbar }: { toolbar: ReactNode }) {
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const feed = useQuery({ queryKey: coordinatorAttentionQueryKey(selectedCompanyId!),
    queryFn: () => attentionApi.list(selectedCompanyId!, { all: true }), enabled: !!selectedCompanyId, refetchOnWindowFocus: true });
  const items = feed.data?.items ?? [];
  const ids = pendingDecisionTaskIds(items);
  const tasks = [...new Map(items.flatMap((item) => {
    const task = item.relatedIssue ?? (item.subject.kind === "issue" ? item.subject : null);
    return task && ids.has(task.id) ? [[task.id, task] as const] : [];
  })).values()].filter((task) => `${task.identifier ?? ""} ${task.title ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <section className="space-y-5">
    <h1 className="text-2xl font-medium">Tasks</h1>
    <div className="flex flex-wrap items-center gap-3">{toolbar}<ToolbarSearch query={search} onQueryChange={setSearch} label="Search tasks needing attention" placeholder="Search tasks…" /></div>
    {feed.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading tasks…</p> : null}
    {feed.isError ? <div role="alert" className="space-y-2"><p>Tasks needing attention could not be loaded.</p><Button variant="outline" onClick={() => void feed.refetch()}>Retry</Button></div> : null}
    {!feed.isPending && !feed.isError && !tasks.length ? <p className="py-8 text-sm text-muted-foreground">{search ? "No tasks match this search." : "No tasks need a decision."}</p> : null}
    <div className="divide-y divide-border">{tasks.map((task) => <button key={task.id} type="button" disabled={!task.href} onClick={() => { if (task.href) navigate(task.href); }} className="flex w-full items-center gap-3 py-4 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <StatusIcon status={task.status ?? "todo"} /><span className="text-sm text-muted-foreground">{task.identifier}</span><span className="flex-1 text-sm">{task.title}</span><span className="text-sm text-muted-foreground">{items.filter((item) => item.relatedIssue?.id === task.id || item.subject.id === task.id).length} pending</span><ArrowUpRight className="size-4 text-muted-foreground" />
    </button>)}</div>
  </section>;
}
