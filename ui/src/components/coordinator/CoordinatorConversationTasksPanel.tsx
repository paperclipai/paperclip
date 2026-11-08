import { t as translateShell, useTranslation } from "@/i18n";
import { useQueryView } from "@/components/QueryView";
import { useMemo, useState } from "react";
import { useCoordinatorChatTaskHandoffs } from "./CoordinatorChatTaskHandoffs";
import { CoordinatorCreatedTaskLink } from "./CoordinatorTaskCommitment";
import { ToolbarSearch } from "@/components/ToolbarSearch";
import { NativeSelect } from "@/components/ui/select";
import { Button } from "@/components/ui/button";

/** The task list is source-conversation scoped, independent of reassignment. */
export function CoordinatorConversationTasksPanel({ conversationIssueId }: { conversationIssueId: string }) {
  const { t: translateShell } = useTranslation("shell");
  const tasks = useCoordinatorChatTaskHandoffs(conversationIssueId);
  const tasksView = useQueryView(tasks);
  const waiting = ["loading", "reconnecting"].includes(tasksView.kind);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("newest");
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return tasks.handoffs.filter(task => (!status || task.status === status) && (!needle || `${task.identifier ?? ""} ${task.title}`.toLocaleLowerCase().includes(needle)))
      .sort((a, b) => sort === "title" ? a.title.localeCompare(b.title) : (sort === "oldest" ? 1 : -1) * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()));
  }, [tasks.handoffs, query, status, sort, translateShell]);
  return <section className="space-y-4" aria-label={translateShell("shell:tasks_from_this_conversation")}>
    <div className="space-y-1"><h2 className="text-lg font-medium">{translateShell("shell:tasks")}</h2><p className="text-sm text-muted-foreground">{translateShell("shell:created_from_this_conversation")}</p></div>
    <ToolbarSearch query={query} onQueryChange={setQuery} label={translateShell("shell:search_conversation_tasks")} placeholder={translateShell("shell:search_tasks_or_ids")} />
    <div className="flex flex-wrap gap-2">
      <NativeSelect value={status} onChange={event => setStatus(event.target.value)} aria-label={translateShell("shell:filter_conversation_tasks_by_status")} className="w-auto"><option value="">{translateShell("shell:all_statuses")}</option><option value="todo">{translateShell("shell:ready_to_start")}</option><option value="in_progress">{translateShell("shell:in_progress")}</option><option value="in_review">{translateShell("shell:needs_review")}</option><option value="blocked">{translateShell("shell:blocked")}</option><option value="done">{translateShell("shell:done")}</option><option value="cancelled">{translateShell("shell:cancelled")}</option></NativeSelect>
      <NativeSelect value={sort} onChange={event => setSort(event.target.value)} aria-label={translateShell("shell:sort_conversation_tasks")} className="w-auto"><option value="newest">{translateShell("shell:newest_first")}</option><option value="oldest">{translateShell("shell:oldest_first")}</option><option value="title">{translateShell("shell:title")}</option></NativeSelect>
    </div>
    {waiting && <p role="status" className="text-sm text-muted-foreground">{translateShell("shell:loading_tasks")}</p>}
    {(tasksView.kind === "error") && <div role="alert" className="space-y-2"><p className="text-sm">{translateShell("shell:tasks_couldn_t_load")}</p><Button variant="outline" onClick={() => void tasks.refetch()}>{translateShell("shell:retry")}</Button></div>}
    <div className="space-y-3">{visible.map(task => <div key={task.id} className="overflow-hidden rounded-xl border border-border bg-card"><CoordinatorCreatedTaskLink task={task} /></div>)}</div>
    {!waiting && !(tasksView.kind === "error") && !visible.length && <p className="py-4 text-sm text-muted-foreground">{query || status ? translateShell("shell:no_loaded_tasks_match_these_filters") : translateShell("shell:tasks_created_from_this_conversation_will_appear")}</p>}
    {tasks.hasNextPage && <Button variant="outline" disabled={tasks.isFetchingNextPage} onClick={() => void tasks.fetchNextPage()}>{tasks.isFetchingNextPage ? translateShell("shell:loading_ba3bbb") : translateShell("shell:load_more_tasks")}</Button>}
  </section>;
}
