import { useTranslation } from "@/i18n";
import { useQueryView } from "@/components/QueryView";
import { useMemo, useState } from "react";
import { useCoordinatorChatTaskHandoffs } from "./CoordinatorChatTaskHandoffs";
import { CoordinatorCreatedTaskLink } from "./CoordinatorTaskCommitment";
import { ToolbarSearch } from "@/components/ToolbarSearch";
import { NativeSelect } from "@/components/ui/select";
import { Button } from "@/components/ui/button";

/** The task list is source-conversation scoped, independent of reassignment. */
export function CoordinatorConversationTasksPanel({ conversationIssueId }: { conversationIssueId: string }) {
  const { t } = useTranslation();
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
  }, [tasks.handoffs, query, status, sort]);
  return <section className="space-y-4" aria-label={t("issues.CoordinatorConversationTasksPanel.tasksAria")}>
    <div className="space-y-1"><h2 className="text-lg font-medium">{t("issues.CoordinatorConversationTasksPanel.title")}</h2><p className="text-sm text-muted-foreground">{t("issues.CoordinatorConversationTasksPanel.createdFrom")}</p></div>
    <ToolbarSearch query={query} onQueryChange={setQuery} label={t("issues.CoordinatorConversationTasksPanel.searchLabel")} placeholder={t("issues.CoordinatorConversationTasksPanel.searchPlaceholder")} />
    <div className="flex flex-wrap gap-2">
      <NativeSelect value={status} onChange={event => setStatus(event.target.value)} aria-label={t("issues.CoordinatorConversationTasksPanel.filterAria")} className="w-auto"><option value="">{t("issues.CoordinatorConversationTasksPanel.allStatuses")}</option><option value="todo">{t("issues.CoordinatorConversationTasksPanel.readyToStart")}</option><option value="in_progress">{t("issues.CoordinatorConversationTasksPanel.inProgress")}</option><option value="in_review">{t("issues.CoordinatorConversationTasksPanel.needsReview")}</option><option value="blocked">{t("issues.CoordinatorConversationTasksPanel.blocked")}</option><option value="done">{t("issues.CoordinatorConversationTasksPanel.done")}</option><option value="cancelled">{t("issues.CoordinatorConversationTasksPanel.cancelled")}</option></NativeSelect>
      <NativeSelect value={sort} onChange={event => setSort(event.target.value)} aria-label={t("issues.CoordinatorConversationTasksPanel.sortAria")} className="w-auto"><option value="newest">{t("issues.CoordinatorConversationTasksPanel.newestFirst")}</option><option value="oldest">{t("issues.CoordinatorConversationTasksPanel.oldestFirst")}</option><option value="title">{t("issues.CoordinatorConversationTasksPanel.sortTitle")}</option></NativeSelect>
    </div>
    {waiting && <p role="status" className="text-sm text-muted-foreground">{t("issues.CoordinatorConversationTasksPanel.loading")}</p>}
    {(tasksView.kind === "error") && <div role="alert" className="space-y-2"><p className="text-sm">{t("issues.CoordinatorConversationTasksPanel.loadError")}</p><Button variant="outline" onClick={() => void tasks.refetch()}>{t("issues.CoordinatorConversationTasksPanel.retry")}</Button></div>}
    <div className="space-y-3">{visible.map(task => <div key={task.id} className="overflow-hidden rounded-xl border border-border bg-card"><CoordinatorCreatedTaskLink task={task} /></div>)}</div>
    {!waiting && !(tasksView.kind === "error") && !visible.length && <p className="py-4 text-sm text-muted-foreground">{query || status ? t("issues.CoordinatorConversationTasksPanel.noFilterMatch") : t("issues.CoordinatorConversationTasksPanel.emptyConversation")}</p>}
    {tasks.hasNextPage && <Button variant="outline" disabled={tasks.isFetchingNextPage} onClick={() => void tasks.fetchNextPage()}>{tasks.isFetchingNextPage ? t("issues.CoordinatorConversationTasksPanel.loadingMore") : t("issues.CoordinatorConversationTasksPanel.loadMore")}</Button>}
  </section>;
}
