import { t as translateShell, useTranslation } from "@/i18n";
import { useQueryView } from "@/components/QueryView";
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
  const { t: translateShell } = useTranslation("shell");
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const feed = useQuery({ queryKey: coordinatorAttentionQueryKey(selectedCompanyId!),
    queryFn: () => attentionApi.list(selectedCompanyId!, { all: true }), enabled: !!selectedCompanyId, refetchOnWindowFocus: true });
  const feedView = useQueryView(feed);
  const waiting = ["loading", "reconnecting"].includes(feedView.kind);
  const items = feed.data?.items ?? [];
  const ids = pendingDecisionTaskIds(items);
  const tasks = [...new Map(items.flatMap((item) => {
    const task = item.relatedIssue ?? (item.subject.kind === "issue" ? item.subject : null);
    return task && ids.has(task.id) ? [[task.id, task] as const] : [];
  })).values()].filter((task) => `${task.identifier ?? ""} ${task.title ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <section className="space-y-5">
    <h1 className="text-2xl font-medium">{translateShell("shell:tasks")}</h1>
    <div className="flex flex-wrap items-center gap-3">{toolbar}<ToolbarSearch query={search} onQueryChange={setSearch} label={translateShell("shell:search_tasks_needing_attention")} placeholder={translateShell("shell:search_tasks")} /></div>
    {waiting ? <p role="status" className="text-sm text-muted-foreground">{translateShell("shell:loading_tasks")}</p> : null}
    {(feedView.kind === "error") ? <div role="alert" className="space-y-2"><p>{translateShell("shell:tasks_needing_attention_could_not_be_loaded")}</p><Button variant="outline" onClick={() => void feed.refetch()}>{translateShell("shell:retry")}</Button></div> : null}
    {!waiting && !(feedView.kind === "error") && !tasks.length ? <p className="py-8 text-sm text-muted-foreground">{search ? translateShell("shell:no_tasks_match_this_search") : translateShell("shell:no_tasks_need_a_decision")}</p> : null}
    <div className="divide-y divide-border">{tasks.map((task) => <button key={task.id} type="button" disabled={!task.href} onClick={() => { if (task.href) navigate(task.href); }} className="flex w-full items-center gap-3 py-4 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <StatusIcon status={task.status ?? "todo"} /><span className="text-sm text-muted-foreground">{task.identifier}</span><span className="flex-1 text-sm">{task.title}</span><span className="text-sm text-muted-foreground">{translateShell("shell:pending", { value1: items.filter((item) => item.relatedIssue?.id === task.id || item.subject.id === task.id).length })}</span><ArrowUpRight className="size-4 text-muted-foreground" />
    </button>)}</div>
  </section>;
}
