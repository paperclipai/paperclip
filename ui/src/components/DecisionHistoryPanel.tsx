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
import { NativeSelect } from "@/components/ui/select";

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
  header,
}: {
  companyId: string;
  agents: Agent[];
  userLabelMap?: ReadonlyMap<string, string>;
  header?: ReactNode;
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
    {header}
    <ToolbarSearch query={search} onQueryChange={setSearch} label="Search decision history" placeholder="Search decisions or task IDs…" />
    <div className="grid grid-cols-2 gap-2">
      <NativeSelect aria-label="Whose decision history" value={scope} onChange={(event) => setScope(event.target.value as DecisionHistoryScope)} className="col-span-2">
        {DECISION_HISTORY_SCOPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </NativeSelect>
      <NativeSelect aria-label="Filter decision outcomes" value={outcome} onChange={(event) => setOutcome(event.target.value)}>
        <option value="">All outcomes</option>
        {DECISION_HISTORY_OUTCOME_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        <option value={HANDLED_FOR_ME}>Handled for me</option>
      </NativeSelect>
      <NativeSelect aria-label="Sort decision history" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></NativeSelect>
      <NativeSelect aria-label="Filter decision history by agent" value={agentId} onChange={(event) => setAgentId(event.target.value)} className="col-span-2"><option value="">All agents</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</NativeSelect>
      <NativeSelect aria-label="Filter decision history by project" value={projectId} onChange={(event) => setProjectId(event.target.value)} className="col-span-2"><option value="">All projects</option>{(projects.data ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</NativeSelect>
      <NativeSelect aria-label="Group decision history" value={groupBy} onChange={(event) => setGroupBy(event.target.value as Group)} className="col-span-2"><option value="none">No grouping</option><option value="task">By task</option><option value="agent">By agent</option><option value="project">By project</option></NativeSelect>
    </div>
    {waiting ? <p role="status" className="text-sm text-muted-foreground">Loading decisions…</p> : null}
    {historyView.kind === "error" ? <QueryErrorState error={historyView.error} onRetry={historyView.retry} /> : null}
    {!waiting && historyView.kind !== "error" && !items.length ? <div className="space-y-2 text-sm text-muted-foreground">
      <p>{scope === "mine" && !search && !outcome && !agentId && !projectId ? "No decisions handled by you or for you yet." : "No decisions match these filters."}</p>
      {scope === "mine" ? <Button variant="outline" size="sm" onClick={() => setScope("all")}>Show everyone's decisions</Button> : null}
    </div> : null}
    <div className="space-y-4">{[...groups].map(([label, entries]) => <section key={label} className="space-y-3">{label ? <h3 className="text-sm font-medium text-muted-foreground">{label}</h3> : null}{entries.map((item) => <div key={item.id} className="space-y-1"><Receipt item={item} onOpen={navigate} userLabelMap={userLabelMap} /><p className="px-1 text-xs text-muted-foreground"><time dateTime={item.resolvedAt}>{new Date(item.resolvedAt).toLocaleString()}</time></p></div>)}</section>)}</div>
    {history.hasNextPage ? <Button variant="outline" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>{history.isFetchingNextPage ? "Loading…" : "Load more decisions"}</Button> : null}
  </div>;
}
