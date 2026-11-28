import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { useState, type ReactNode } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { Agent, DecisionHistoryScope } from "@paperclipai/shared";
import { attentionApi } from "@/api/attention";
import { projectsApi } from "@/api/projects";
import { useNavigate } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { DECISION_HISTORY_OUTCOME_OPTIONS, DECISION_HISTORY_SCOPE_OPTIONS, DEFAULT_DECISION_HISTORY_SCOPE } from "@/lib/coordinator-attention";
import { CoordinatorDecisionReceipt as Receipt } from "@/components/coordinator/CoordinatorDecisionReceipt";
import { ToolbarSearch } from "@/components/ToolbarSearch";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { InboxFilter } from "@/components/InboxFilter";

type Group = "none" | "task" | "agent" | "project";

/** "Handled for me" is a filter on who the card was for, not an outcome (PAP-749 plan §6). */
const HANDLED_FOR_ME = "handled_for_me";

/**
 * The Decision history panel of both Decisions pages (PAP-749 plan §3): every
 * closed card — answered, approved, withdrawn, expired or closed with its
 * task, approvals included. It opens on "Handled by me or for me"; Everyone
 * lists every person's (PAP-768). Search, filter by outcome, agent and
 * project within either, and open the task or approval.
 */
export function DecisionHistoryPanel({
  companyId,
  agents,
  userLabelMap,
  afterControls,
}: {
  companyId: string;
  agents: Agent[];
  userLabelMap?: ReadonlyMap<string, string>;
  afterControls?: ReactNode;
}) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [outcome, setOutcome] = useState("");
  const [agentId, setAgentId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [groupBy, setGroupBy] = useState<Group>("none");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [scope, setScope] = useState<DecisionHistoryScope>(DEFAULT_DECISION_HISTORY_SCOPE);
  const projects = useQuery({ queryKey: queryKeys.projects.list(companyId), queryFn: () => projectsApi.list(companyId) });
  const history = useInfiniteQuery({
    queryKey: [...queryKeys.attention(companyId), "history", { search, outcome, agentId, projectId, sort, scope }],
    queryFn: ({ pageParam }) => attentionApi.history(companyId, {
      search, agentId, projectId, sort, scope, cursor: pageParam, limit: 40,
      ...(outcome === HANDLED_FOR_ME ? { handledForMe: true } : { outcome }),
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const historyView = useQueryView(history);
  const waiting = historyView.kind === "loading" || historyView.kind === "reconnecting";
  const items = history.data?.pages.flatMap((page) => page.items) ?? [];
  const groups = new Map<string, typeof items>();
  for (const item of items) {
    const label = groupBy === "task" ? item.issueIdentifier ?? item.issueTitle ?? "No task" : groupBy === "agent" ? item.agentName ?? "Other agents" : groupBy === "project" ? item.projectName ?? "No project" : "";
    groups.set(label, [...(groups.get(label) ?? []), item]);
  }
  return <div className="space-y-5" data-decision-history>
    <div role="toolbar" aria-label="Decision history controls" className="space-y-5">
      <ToolbarSearch query={search} onQueryChange={setSearch} label="Search decision history" placeholder="Search decisions or task IDs…" />
      <div data-canonical-toolbar="history">
        <InboxFilter<DecisionHistoryScope> label="Whose decision history" heading="Whose decisions" value={scope}
          options={DECISION_HISTORY_SCOPE_OPTIONS} onChange={setScope} />
        <InboxFilter label="Filter decision outcomes" heading="Outcome" value={outcome} onChange={setOutcome}
          options={[{ value: "", label: "All outcomes" }, ...DECISION_HISTORY_OUTCOME_OPTIONS, { value: HANDLED_FOR_ME, label: "Handled for me" }]} />
        <InboxFilter<typeof sort> label="Sort decision history" heading="Sort by" value={sort} onChange={setSort}
          options={[{ value: "newest", label: "Newest first" }, { value: "oldest", label: "Oldest first" }]} />
        <InboxFilter label="Filter decision history by agent" heading="Agents" value={agentId} onChange={setAgentId}
          options={[{ value: "", label: "All agents" }, ...agents.map(agent => ({ value: agent.id, label: agent.name }))]} />
        <InboxFilter label="Filter decision history by project" heading="Projects" value={projectId} onChange={setProjectId}
          options={[{ value: "", label: "All projects" }, ...(projects.data ?? []).map(project => ({ value: project.id, label: project.name }))]} />
        <InboxFilter<Group> label="Group decision history" heading="Group by" value={groupBy} onChange={setGroupBy}
          options={[{ value: "none", label: "No grouping" }, { value: "task", label: "By task" }, { value: "agent", label: "By agent" }, { value: "project", label: "By project" }]} />
      </div>
    </div>
    {afterControls}
    {waiting ? <p role="status" className="text-sm text-muted-foreground">Loading decisions…</p> : null}
    {historyView.kind === "error" ? <QueryErrorState error={historyView.error} onRetry={historyView.retry} /> : null}
    {!waiting && historyView.kind !== "error" && !items.length && <EmptyState placement="upper"
      message={scope === "mine" && !search && !outcome && !agentId && !projectId ? "No decisions handled by you or for you yet." : "No decisions match these filters."}
      action={scope === "mine" ? "Show everyone's decisions" : undefined}
      onAction={() => setScope("all")}
      hideActionIcon
    />}
    <div className="space-y-4">{[...groups].map(([label, entries]) => <section key={label} className="space-y-3">
      {label && <h3 className="text-sm font-medium text-muted-foreground">{label}</h3>}
      {entries.map(item => <Receipt key={item.id} item={item} onOpen={navigate} userLabelMap={userLabelMap} showTimestamp />)}
    </section>)}</div>
    {history.hasNextPage ? <Button variant="outline" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>{history.isFetchingNextPage ? "Loading…" : "Load more decisions"}</Button> : null}
  </div>;
}
