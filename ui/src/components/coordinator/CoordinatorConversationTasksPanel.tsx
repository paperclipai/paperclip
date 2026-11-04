import { useMemo, useState } from "react";
import { useCoordinatorChatTaskHandoffs } from "./CoordinatorChatTaskHandoffs";
import { CoordinatorCreatedTaskLink } from "./CoordinatorTaskCommitment";
import { ToolbarSearch } from "@/components/ToolbarSearch";
import { NativeSelect } from "@/components/ui/select";
import { Button } from "@/components/ui/button";

/** The task list is source-conversation scoped, independent of reassignment. */
export function CoordinatorConversationTasksPanel({ conversationIssueId }: { conversationIssueId: string }) {
  const tasks = useCoordinatorChatTaskHandoffs(conversationIssueId);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("newest");
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return tasks.handoffs.filter(task => (!status || task.status === status) && (!needle || `${task.identifier ?? ""} ${task.title}`.toLocaleLowerCase().includes(needle)))
      .sort((a, b) => sort === "title" ? a.title.localeCompare(b.title) : (sort === "oldest" ? 1 : -1) * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()));
  }, [tasks.handoffs, query, status, sort]);
  return <section className="space-y-4" aria-label="Tasks from this conversation">
    <div className="space-y-1"><h2 className="text-lg font-medium">Tasks</h2><p className="text-sm text-muted-foreground">Created from this conversation.</p></div>
    <ToolbarSearch query={query} onQueryChange={setQuery} label="Search conversation tasks" placeholder="Search tasks or IDs…" />
    <div className="flex flex-wrap gap-2">
      <NativeSelect value={status} onChange={event => setStatus(event.target.value)} aria-label="Filter conversation tasks by status" className="w-auto"><option value="">All statuses</option><option value="todo">Ready to start</option><option value="in_progress">In progress</option><option value="in_review">Needs review</option><option value="blocked">Blocked</option><option value="done">Done</option><option value="cancelled">Cancelled</option></NativeSelect>
      <NativeSelect value={sort} onChange={event => setSort(event.target.value)} aria-label="Sort conversation tasks" className="w-auto"><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="title">Title</option></NativeSelect>
    </div>
    {tasks.isPending && <p role="status" className="text-sm text-muted-foreground">Loading tasks…</p>}
    {tasks.isError && <div role="alert" className="space-y-2"><p className="text-sm">Tasks couldn’t load.</p><Button variant="outline" onClick={() => void tasks.refetch()}>Retry</Button></div>}
    <div className="space-y-3">{visible.map(task => <div key={task.id} className="overflow-hidden rounded-xl border border-border bg-card"><CoordinatorCreatedTaskLink task={task} /></div>)}</div>
    {!tasks.isPending && !tasks.isError && !visible.length && <p className="py-4 text-sm text-muted-foreground">{query || status ? "No loaded tasks match these filters." : "Tasks created from this conversation will appear here."}</p>}
    {tasks.hasNextPage && <Button variant="outline" disabled={tasks.isFetchingNextPage} onClick={() => void tasks.fetchNextPage()}>{tasks.isFetchingNextPage ? "Loading…" : "Load more tasks"}</Button>}
  </section>;
}
