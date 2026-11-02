import { t, useTranslation } from "@/i18n";
import { useMemo, useState } from "react";
import { useCoordinatorChatTaskHandoffs } from "./CoordinatorChatTaskHandoffs";
import { CoordinatorCreatedTaskLink } from "./CoordinatorTaskCommitment";
import { ToolbarSearch } from "@/components/ToolbarSearch";
import { NativeSelect } from "@/components/ui/select";
import { Button } from "@/components/ui/button";

/** The task list is source-conversation scoped, independent of reassignment. */
export function CoordinatorConversationTasksPanel({ conversationIssueId }: { conversationIssueId: string }) {
  useTranslation();
  const tasks = useCoordinatorChatTaskHandoffs(conversationIssueId);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("newest");
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return tasks.handoffs.filter(task => (!status || task.status === status) && (!needle || `${task.identifier ?? ""} ${task.title}`.toLocaleLowerCase().includes(needle)))
      .sort((a, b) => sort === "title" ? a.title.localeCompare(b.title) : (sort === "oldest" ? 1 : -1) * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()));
  }, [tasks.handoffs, query, status, sort]);
  return <section className="space-y-4" aria-label={t("nov02Root.copy8752e6d1a1")}>
    <div className="space-y-1"><h2 className="text-lg font-medium">{t("nov02Root.copyb3a60e61a5")}</h2><p className="text-sm text-muted-foreground">{t("nov02Root.copy379e4f9c80")}</p></div>
    <ToolbarSearch query={query} onQueryChange={setQuery} label={t("nov02Root.copya85cd5124a")} placeholder={t("nov02Root.copy79f9b89a0d")} />
    <div className="flex flex-wrap gap-2">
      <NativeSelect value={status} onChange={event => setStatus(event.target.value)} aria-label={t("nov02Root.copyde43fd9c3d")} className="w-auto"><option value="">{t("nov02Root.copy8ee57323a6")}</option><option value="todo">{t("nov02Root.copybc403cd60f")}</option><option value="in_progress">{t("nov02Root.copyc1f88e9d6c")}</option><option value="in_review">{t("nov02Root.copy07297fa94a")}</option><option value="blocked">{t("nov02Root.copy18f2a0947f")}</option><option value="done">{t("nov02Root.copy11a6767d56")}</option><option value="cancelled">{t("nov02Root.copyd353a99eb4")}</option></NativeSelect>
      <NativeSelect value={sort} onChange={event => setSort(event.target.value)} aria-label={t("nov02Root.copy60587310b9")} className="w-auto"><option value="newest">{t("nov02Root.copyffb6f5764b")}</option><option value="oldest">{t("nov02Root.copy6e2ebdab3c")}</option><option value="title">{t("nov02Root.copy7e8cd2056d")}</option></NativeSelect>
    </div>
    {tasks.isPending && <p role="status" className="text-sm text-muted-foreground">{t("nov02Root.copy9ae9f7d835")}</p>}
    {tasks.isError && <div role="alert" className="space-y-2"><p className="text-sm">{t("nov02Root.copy6efc21ac5f")}</p><Button variant="outline" onClick={() => void tasks.refetch()}>{t("nov02Root.copy942087cc2d")}</Button></div>}
    <div className="space-y-3">{visible.map(task => <div key={task.id} className="overflow-hidden rounded-xl border border-border bg-card"><CoordinatorCreatedTaskLink task={task} /></div>)}</div>
    {!tasks.isPending && !tasks.isError && !visible.length && <p className="py-4 text-sm text-muted-foreground">{query || status ? t("nov02Root.copyd41a500a2c") : t("nov02Root.copy1dbab0dd1a")}</p>}
    {tasks.hasNextPage && <Button variant="outline" disabled={tasks.isFetchingNextPage} onClick={() => void tasks.fetchNextPage()}>{tasks.isFetchingNextPage ? t("nov02Root.copyba3bbbe10d") : t("nov02Root.copyaf07ba09cb")}</Button>}
  </section>;
}
