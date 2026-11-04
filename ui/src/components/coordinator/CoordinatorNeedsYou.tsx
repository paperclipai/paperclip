import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight, ChevronDown, History, ListFilter, Loader2, Mail } from "lucide-react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import type { Agent, AttentionCloseMode, AttentionItem, AttentionPersonalView, DecisionHistoryItem, DecisionHistoryScope } from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { attentionApi } from "@/api/attention";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { usePanel } from "@/context/PanelContext";
import { useSidebar } from "@/context/SidebarContext";
import { useCoordinatorWorkspaceEnabled } from "@/hooks/useCoordinatorWorkspaceEnabled";
import { useAttentionBadge, useAttentionCloseActions, useAttentionEveryoneView, useAttentionViewFeed, useClaimAttentionItem, useDismissAttentionReceipt } from "@/hooks/useAttentionViews";
import { useNavigate, useSearchParams } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { COORDINATOR_RECENT_DECISION_MS, DECISION_HISTORY_SCOPE_OPTIONS, DEFAULT_DECISION_HISTORY_SCOPE, coordinatorCardTitle, recentDecisionReceipts } from "@/lib/coordinator-attention";
import { attentionDetailLine, isInlineResolvable } from "@/lib/attention";
import { ATTENTION_VIEW_LABELS, ATTENTION_VIEW_PARAM, attentionAudienceLineNamesResponders, parseAttentionView } from "@/lib/attention-views";
import { splitArchivedAttentionItems, splitStaleAttentionItems } from "@/lib/attention-close";
import { attentionObligationEvidence, foldAttentionObligations } from "@/lib/attention-obligations";
import { buildCompanyUserLabelMap } from "@/lib/company-members";
import { AttentionAudienceLine, AttentionReceiptList } from "@/components/AttentionViews";
import { AttentionCloseMenu, AttentionForOtherGate, AttentionHiddenChip, AttentionSnoozedGroup, AttentionStaleChip, AttentionStaleGroup } from "@/components/AttentionCloseMenu";
import { BudgetAlertActions, FailedRunActions } from "@/components/AttentionInlineVerbs";
import { AttentionInteractionResolver } from "@/components/AttentionInteractionResolver";
import { AttentionObligationEvidence } from "@/components/AttentionObligationEvidence";
import { StalledReviewActions } from "@/components/StalledReviewActions";
import { DecisionHistoryPanel } from "@/components/DecisionHistoryPanel";
import { DecisionResolver } from "@/components/DecisionResolver";
import { PROPERTIES_PANE_HEADER_SLOT_ID } from "@/components/PropertiesPanel";
import { SidePanelTab } from "@/components/side-panel";
import { ToolbarSearch } from "@/components/ToolbarSearch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { NativeSelect } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { parseCssTimeMs } from "@/components/task-chat/motion-tokens";
import { readIssueReviewPolicyMetadata } from "@/lib/review-policy";
import { CoordinatorDecisionReceipt as Receipt } from "./CoordinatorDecisionReceipt";
import { CoordinatorTaskMotion } from "./CoordinatorTaskCommitment";

type Group = "none" | "task" | "agent" | "project";

/** Rule 7: a card that cannot answer inline links to the exact control, named by its verb. */
function openLabel(item: AttentionItem) {
  return (item.decisionVerbs ?? []).find((verb) => verb.id === "open_recovery" || verb.id === "inspect")?.label ?? "Open to review";
}

const EMPTY_VIEW_TEXT: Record<AttentionPersonalView, string> = {
  mine: "You're caught up.",
  unassigned: "No cards need an owner.",
  company: "No company alerts right now.",
  archived: "Nothing archived. Cards you archive or snooze for yourself show here.",
  all: "No open cards for anyone.",
};

/** The shared Decision history panel, with its tab in the side panel header on desktop. */
function HistoryPanel({ companyId, agents, userLabelMap, onClose, mobile = false }: { companyId: string; agents: Agent[]; userLabelMap?: ReadonlyMap<string, string>; onClose: () => void; mobile?: boolean }) {
  const slot = typeof document !== "undefined" ? document.getElementById(PROPERTIES_PANE_HEADER_SLOT_ID) : null;
  const tab = <SidePanelTab id="decision-history" label="Decision history" active onSelect={() => {}} onClose={onClose} />;
  return <div data-coordinator-decision-history>
    <DecisionHistoryPanel companyId={companyId} agents={agents} userLabelMap={userLabelMap}
      header={!mobile ? <>{slot ? createPortal(tab, slot) : tab}<h2 className="text-lg font-medium">Decision history</h2></> : null} />
  </div>;
}

export function CoordinatorNeedsYou() {
  const { selectedCompanyId } = useCompany();
  const { userId } = useCoordinatorWorkspaceEnabled();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openPanel, closePanel, setPanelVisible } = usePanel();
  const { isMobile } = useSidebar();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkDecisionId = searchParams.get("decisionId");
  // For you is the default; the other views live in the URL (PAP-749 Rule 3).
  // Everyone opens for a board member only (PAP-768).
  const everyone = useAttentionEveryoneView(selectedCompanyId);
  const view = parseAttentionView(searchParams.get(ATTENTION_VIEW_PARAM), { everyone });
  const setView = useCallback((next: typeof view) => setSearchParams(current => {
    const params = new URLSearchParams(current);
    if (next === "mine") params.delete(ATTENTION_VIEW_PARAM); else params.set(ATTENTION_VIEW_PARAM, next);
    return params;
  }, { replace: true }), [setSearchParams]);
  const reducedMotion = useReducedMotion();
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [groupBy, setGroupBy] = useState<Group>("none");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [settling, setSettling] = useState<AttentionItem[]>([]);
  const [savedIds, setSavedIds] = useState<Set<string>>(() => new Set());
  // The Stale (N) group starts collapsed in each view; the Archived view's
  // Snoozed group starts open (PAP-749 plan §3).
  const [staleOpen, setStaleOpen] = useState(false);
  const [snoozedOpen, setSnoozedOpen] = useState(true);
  // Focus (PAP-770): controls on request — filters stay behind one entry point,
  // and receipts collapse to a single line until opened.
  const [showFilters, setShowFilters] = useState(false);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  useEffect(() => { setSettling([]); setSavedIds(new Set()); setStaleOpen(false); setSnoozedOpen(true); }, [selectedCompanyId, userId, view]);
  const archivedView = view === "archived";
  const [renderLimit, setRenderLimit] = useState(40);
  // Keyed by person and view; the For you key is the one the badge reads.
  const feed = useAttentionViewFeed(selectedCompanyId, view);
  const { viewCounts } = useAttentionBadge(selectedCompanyId);
  const claim = useClaimAttentionItem(selectedCompanyId);
  const receiptActions = useDismissAttentionReceipt(selectedCompanyId);
  const directory = useQuery({ queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!), queryFn: () => accessApi.listUserDirectory(selectedCompanyId!), enabled: !!selectedCompanyId });
  const userLabelMap = useMemo(() => buildCompanyUserLabelMap(directory.data?.users), [directory.data?.users]);
  // A closed card leaves the list at once; a withdrawn one comes back as a
  // receipt in Recent Decisions after the history refetch. In the Archived
  // view a new snooze time keeps the card (it only changes group), and a
  // restored card leaves it; elsewhere an Undo brings the card straight back.
  const hideCard = useCallback((item: AttentionItem) => {
    setSavedIds(current => new Set([...current, `${item.sourceKind}:${item.subject.id}`]));
  }, []);
  const showCard = useCallback((item: AttentionItem) => {
    setSavedIds(current => { const next = new Set(current); next.delete(`${item.sourceKind}:${item.subject.id}`); return next; });
  }, []);
  const onCardClosed = useCallback((item: AttentionItem, mode: AttentionCloseMode) => {
    if (archivedView && mode !== "withdraw") return;
    hideCard(item);
  }, [archivedView, hideCard]);
  const onCardRestored = useCallback((item: AttentionItem) => (archivedView ? hideCard : showCard)(item), [archivedView, hideCard, showCard]);
  const closeActions = useAttentionCloseActions(selectedCompanyId, { userLabelMap, onClosed: onCardClosed, onRestored: onCardRestored });
  const agentQuery = useQuery({ queryKey: queryKeys.agents.list(selectedCompanyId!), queryFn: () => agentsApi.list(selectedCompanyId!), enabled: !!selectedCompanyId });
  // Full history lives in its own paginated tab. Only the newest bounded page
  // is fetched here; its window expires visually without deleting any record.
  // Like Decision history it opens on yours; Everyone is one choice away (PAP-768).
  const [recentScope, setRecentScope] = useState<DecisionHistoryScope>(DEFAULT_DECISION_HISTORY_SCOPE);
  const recent = useQuery({ queryKey: [...queryKeys.attention(selectedCompanyId!), "history", "recent", recentScope],
    queryFn: () => attentionApi.history(selectedCompanyId!, { limit: 100, scope: recentScope, since: new Date(Date.now() - COORDINATOR_RECENT_DECISION_MS).toISOString() }), enabled: !!selectedCompanyId, refetchOnWindowFocus: true });
  const agentMap = useMemo(() => new Map((agentQuery.data ?? []).map((agent) => [agent.id, agent])), [agentQuery.data]);
  const recentItems = useMemo(() => recentDecisionReceipts(recent.data?.items ?? [], now), [recent.data, now]);
  const settlingIds = useMemo(() => new Set(settling.map(item => `${item.sourceKind}:${item.subject.id}`)), [settling]);
  const visibleRecentItems = useMemo(() => recentItems.filter((item) => {
    if (settlingIds.has(item.id)) return false;
    if (agentFilter && item.agentId !== agentFilter) return false;
    if (projectFilter && item.projectId !== projectFilter) return false;
    return [item.title, item.issueTitle, item.issueIdentifier, item.agentName, item.projectName, item.label]
      .join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  }).sort((a, b) => (sort === "oldest" ? 1 : -1) * (Date.parse(a.resolvedAt) - Date.parse(b.resolvedAt))),
  [recentItems, settlingIds, agentFilter, projectFilter, query, sort]);
  const recentGroups = useMemo(() => {
    const result = new Map<string, DecisionHistoryItem[]>();
    for (const item of visibleRecentItems) {
      const label = groupBy === "task" ? item.issueIdentifier ?? item.issueTitle ?? "No task"
        : groupBy === "agent" ? item.agentName ?? "Other agents"
          : groupBy === "project" ? item.projectName ?? "No project" : "";
      result.set(label, [...(result.get(label) ?? []), item]);
    }
    return [...result];
  }, [visibleRecentItems, groupBy]);
  // One card for each obligation (PAP-749 Rule 11): evidence folds into its
  // lead before the page hides, splits or groups anything.
  const obligations = useMemo(() => foldAttentionObligations(feed.data?.items ?? []), [feed.data]);
  const pendingItems = useMemo(() => {
    const receipts = new Set(recentItems.map((item) => item.id));
    const items = new Map(obligations.cards.map((item) => [`${item.sourceKind}:${item.subject.id}`, item]));
    for (const item of settling) if (!items.has(`${item.sourceKind}:${item.subject.id}`)) items.set(`${item.sourceKind}:${item.subject.id}`, item);
    return [...items].filter(([key]) => settlingIds.has(key) || (!receipts.has(key) && !savedIds.has(key))).map(([, item]) => item);
  }, [obligations, settling, settlingIds, recentItems, savedIds]);
  const filtered = useMemo(() => pendingItems.filter((item) => {
    const agentId = String(item.subject.metadata?.createdByAgentId ?? item.subject.metadata?.originAgentId ?? "");
    if (agentFilter && agentId !== agentFilter && item.originAgentName !== agentMap.get(agentFilter)?.name) return false;
    if (projectFilter && item.project?.id !== projectFilter) return false;
    return [item.subject.title, item.relatedIssue?.title, item.relatedIssue?.identifier, item.originAgentName, item.project?.name, attentionDetailLine(item)].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  }).sort((a, b) => (sort === "oldest" ? 1 : -1) * (Date.parse(a.activityAt) - Date.parse(b.activityAt))), [pendingItems, agentFilter, projectFilter, query, sort, agentMap]);
  // Stale cards go to the collapsed group at the bottom of each view (Rule 10).
  // The Archived view keeps stale cards in place with their chip, and puts
  // snoozed cards in their own group (plan §3).
  const { current: currentItems, stale: staleItems, snoozed: snoozedItems } = useMemo(() => {
    if (archivedView) {
      const { archived, snoozed } = splitArchivedAttentionItems(filtered);
      return { current: archived, stale: [] as AttentionItem[], snoozed };
    }
    return { ...splitStaleAttentionItems(filtered), snoozed: [] as AttentionItem[] };
  }, [archivedView, filtered]);
  const groups = useMemo(() => {
    const result = new Map<string, AttentionItem[]>();
    for (const item of currentItems.slice(0, renderLimit)) {
      const label = groupBy === "task" ? item.relatedIssue?.identifier ?? item.relatedIssue?.title ?? "Other decisions"
        : groupBy === "agent" ? item.originAgentName ?? "Other agents" : groupBy === "project" ? item.project?.name ?? "No project" : "";
      result.set(label, [...(result.get(label) ?? []), item]);
    }
    return [...result];
  }, [currentItems, groupBy, renderLimit]);
  useEffect(() => {
    if (!deepLinkDecisionId || !selectedCompanyId || !pendingItems.some(item => item.sourceKind === "decision" && item.subject.id === deepLinkDecisionId)) return;
    // A saved decision link takes precedence over local toolbar filters and the
    // rendering window. Consume it only after its actual card has mounted.
    if (query || agentFilter || projectFilter) { setQuery(""); setAgentFilter(""); setProjectFilter(""); return; }
    if (staleItems.some(item => item.sourceKind === "decision" && item.subject.id === deepLinkDecisionId)) setStaleOpen(true);
    const index = currentItems.findIndex(item => item.sourceKind === "decision" && item.subject.id === deepLinkDecisionId);
    if (index >= renderLimit) { setRenderLimit(Math.ceil((index + 1) / 40) * 40); return; }
    const card = document.getElementById(`coordinator-decision-${deepLinkDecisionId}`);
    if (!card) return;
    card.focus({ preventScroll: true });
    card.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
    setSearchParams(current => { const next = new URLSearchParams(current); next.delete("decisionId"); return next; }, { replace: true });
  }, [deepLinkDecisionId, selectedCompanyId, pendingItems, currentItems, staleItems, query, agentFilter, projectFilter, renderLimit, reducedMotion, setSearchParams]);
  const projects = useMemo(() => [...new Map([
    ...pendingItems.flatMap((item) => item.project ? [[item.project.id, item.project.name] as const] : []),
    ...recentItems.flatMap((item) => item.projectId ? [[item.projectId, item.projectName ?? "Unnamed project"] as const] : []),
  ]).entries()], [pendingItems, recentItems]);
  const filtersActive = Boolean(query.trim() || agentFilter || projectFilter);
  const closeHistory = useCallback(() => { setHistoryOpen(false); closePanel(); }, [closePanel]);
  const showHistory = () => { setHistoryOpen(true); if (!isMobile) setPanelVisible(true); };
  useEffect(() => { setBreadcrumbs([{ label: "Needs You" }]); }, [setBreadcrumbs]);
  useEffect(() => {
    setSettling([]); setHistoryOpen(false); setNow(Date.now()); closePanel();
    return closePanel;
  }, [selectedCompanyId, closePanel]);
  useEffect(() => {
    if (!historyOpen || !selectedCompanyId || isMobile) { closePanel(); return; }
    setPanelVisible(true);
    openPanel(<HistoryPanel companyId={selectedCompanyId} agents={agentQuery.data ?? []} userLabelMap={userLabelMap} onClose={closeHistory} />);
  }, [historyOpen, selectedCompanyId, isMobile, agentQuery.data, userLabelMap, openPanel, closePanel, closeHistory, setPanelVisible]);
  useEffect(() => {
    const next = recentItems.reduce((earliest, item) => Math.min(earliest, Date.parse(item.resolvedAt) + COORDINATOR_RECENT_DECISION_MS), Infinity);
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 1);
    return () => window.clearTimeout(timer);
  }, [recentItems]);
  const onResolved = (item: AttentionItem) => {
    const id = `${item.sourceKind}:${item.subject.id}`;
    setSavedIds(current => new Set([...current, id]));
    setSettling(current => current.some(entry => entry.id === item.id) ? current : [...current, item]);
    void recent.refetch().then(result => {
      if (result.isError) setSettling(current => current.filter(entry => `${entry.sourceKind}:${entry.subject.id}` !== id));
    });
    void feed.refetch();
  };
  const duration = typeof document === "undefined" ? 0 : parseCssTimeMs(getComputedStyle(document.documentElement).getPropertyValue("--motion-duration-base")) / 1_000;
  const renderCard = (item: AttentionItem) => {
    const issueId = item.relatedIssue?.id ?? String(item.subject.metadata?.issueId ?? "");
    const interaction = item.sourceKind === "issue_thread_interaction" && isInlineResolvable(item) && issueId;
    const decision = item.sourceKind === "decision" && isInlineResolvable(item);
    const stalledReview = item.sourceKind === "review" && item.subject.kind === "issue" && isInlineResolvable(item) && item.subject.metadata?.reviewAttentionState === "stalled";
    const failedRun = item.sourceKind === "failed_run" && isInlineResolvable(item);
    const budget = item.sourceKind === "budget_alert" && isInlineResolvable(item);
    const taskRef = item.relatedIssue ?? (item.subject.kind === "issue" ? item.subject : null);
    const taskLink = taskRef?.href ? <button type="button" onClick={() => { if (taskRef.href) navigate(taskRef.href); }} className="flex max-w-full items-center gap-2 text-left text-sm text-muted-foreground hover:text-foreground"><span className="shrink-0">{taskRef.identifier ?? "Open task"}</span><span className="truncate">{taskRef.title}</span><ArrowUpRight className="size-4 shrink-0" /></button> : null;
    const id = `${item.sourceKind}:${item.subject.id}`;
    const receipt = settlingIds.has(id) ? recentItems.find(entry => entry.id === id) : undefined;
    const phase = !receipt ? "pending" : ["cancelled", "expired"].includes(receipt.outcome) ? "closed" : "resolved";
    const refetchAll = () => { void feed.refetch(); void recent.refetch(); };
    const heading = <><h2 className="text-lg font-medium">{coordinatorCardTitle(item)}</h2><p className="text-sm">{attentionDetailLine(item) ?? item.whyNow}</p></>;
    return <motion.div id={item.sourceKind === "decision" ? `coordinator-decision-${item.subject.id}` : undefined} tabIndex={item.sourceKind === "decision" ? -1 : undefined} layout={reducedMotion ? false : "position"} layoutId={reducedMotion ? undefined : id} transition={{ duration }} key={id}>
    <CoordinatorTaskMotion eventId={`decision:${selectedCompanyId}:${userId}:${id}`} phase={phase} createdAt={item.activityAt} className="coordinator-decision-motion"
      onSettled={() => setSettling(current => current.filter(entry => `${entry.sourceKind}:${entry.subject.id}` !== id))}>
    {receipt ? <Receipt item={receipt} onOpen={navigate} userLabelMap={userLabelMap} /> : <article className="coordinator-decision-card space-y-4 rounded-xl border border-border bg-card p-6" data-attention-card={item.id}>
      {/* Why this card is here, whether it is stale, and its one Close… menu (PAP-749 Rules 4, 6, 10). */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <AttentionHiddenChip item={item} />
          <AttentionStaleChip item={item} />
          <AttentionAudienceLine item={item} currentUserId={userId} userLabelMap={userLabelMap} onClaim={entry => claim.mutate(entry)} claiming={claim.isPending && claim.variables?.id === item.id} />
        </div>
        <AttentionCloseMenu item={item} currentUserId={userId} userLabelMap={userLabelMap}
          busy={closeActions.closingItemId === item.id || closeActions.transferringItemId === item.id}
          onWithdraw={(entry, reason) => closeActions.close({ item: entry, mode: "withdraw", reason })}
          onArchive={entry => closeActions.close({ item: entry, mode: "archive" })}
          onSnooze={(entry, until) => closeActions.close({ item: entry, mode: "snooze", until })}
          onTransfer={(entry, target) => closeActions.transfer({ item: entry, userId: target })}
          onRestore={archivedView ? entry => void closeActions.restore(entry) : undefined} />
      </div>
      <AttentionForOtherGate item={item} currentUserId={userId} userLabelMap={userLabelMap}>
      {interaction ? <AttentionInteractionResolver footerSlot={taskLink} presentation="coordinator-decision" audienceStated={attentionAudienceLineNamesResponders(item, userId)} companyId={selectedCompanyId!} issueId={issueId} interactionId={item.subject.id} agentMap={agentMap} currentUserId={userId} onResolved={resolved => {
        if (!resolved || resolved.status === "pending") { refetchAll(); return; }
        onResolved(item);
      }} />
        : decision ? <DecisionResolver companyId={selectedCompanyId!} decisionId={item.subject.id} originIssue={item.relatedIssue} agentMap={agentMap} onResolved={() => onResolved(item)} />
        : stalledReview ? <><h2 className="text-lg font-medium">Choose how this task continues</h2><p className="text-sm">This task is still in review with no active reviewer or continuation. Return it to work, request changes, or mark the task done.</p><StalledReviewActions footerSlot={taskLink} issueId={item.subject.id} companyId={selectedCompanyId!} reviewPolicy={readIssueReviewPolicyMetadata(item.subject.metadata)} approveLabel="Mark task done" onResolved={refetchAll} /></>
        : failedRun ? <>{heading}<FailedRunActions item={item} companyId={selectedCompanyId!} leading={taskLink} onResolved={refetchAll} /></>
        : budget ? <>{heading}<BudgetAlertActions item={item} companyId={selectedCompanyId!} onResolved={refetchAll} /></>
        : <>{heading}<Button disabled={!item.subject.href} onClick={() => { if (item.subject.href) navigate(item.subject.href); }}>{openLabel(item)}<ArrowUpRight className="size-4" /></Button></>}
      </AttentionForOtherGate>
      <AttentionObligationEvidence item={item} evidence={attentionObligationEvidence(obligations, item)} />
      {!interaction && !stalledReview && !failedRun ? taskLink : null}
    </article>}
    </CoordinatorTaskMotion>
    </motion.div>;
  };
  if (!selectedCompanyId) return <p className="text-sm text-muted-foreground">Choose a company to see its decisions.</p>;
  return <LayoutGroup id="coordinator-decisions"><section className="coordinator-needs-you mx-auto w-full max-w-4xl space-y-6" aria-label="Needs You">
    {isMobile ? <Sheet open={historyOpen} onOpenChange={open => { if (!open) closeHistory(); }}>
      <SheetContent side="bottom" aria-describedby={undefined} className="mobile-task-side-panel inset-0 h-dvh max-h-dvh w-full max-w-none gap-0 border-0 p-0 pt-(--sz-safe-top) pb-(--sz-safe-bottom)">
        <SheetHeader><SheetTitle>Decision history</SheetTitle></SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4"><HistoryPanel companyId={selectedCompanyId} agents={agentQuery.data ?? []} userLabelMap={userLabelMap} onClose={closeHistory} mobile /></div>
      </SheetContent>
    </Sheet> : null}
    <header className="flex items-center justify-between gap-3"><h1 className="text-2xl font-medium">Needs You</h1><Button variant="ghost" onClick={showHistory}><History className="size-4" />Decision history</Button></header>
    {/* Focus (PAP-770): For you is the page; Unassigned/Company are quiet chips,
        Archived/Everyone/History fold into View, and filters hide behind one icon. */}
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {view === "mine" ? null : <Button variant="ghost" size="sm" onClick={() => setView("mine")}><ArrowLeft className="size-4" />For you</Button>}
        {([["unassigned", viewCounts.unassigned], ["company", viewCounts.company]] as const).map(([chipView, count]) =>
          count > 0 || view === chipView ? (
            <Button key={chipView} data-attention-view={chipView} aria-selected={view === chipView} variant={view === chipView ? "secondary" : "ghost"} size="sm" onClick={() => setView(chipView)}>
              {ATTENTION_VIEW_LABELS[chipView]}{count > 0 ? <Badge variant="secondary" data-attention-view-count={chipView}>{count}</Badge> : null}
            </Button>
          ) : null)}
      </div>
      <div className="flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" data-attention-view-menu>View<ChevronDown className="size-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setView("archived")}>Archived{viewCounts.archived ? ` · ${viewCounts.archived}` : ""}</DropdownMenuItem>
            {everyone ? <DropdownMenuItem onSelect={() => setView("all")}>Everyone · {viewCounts.all}</DropdownMenuItem> : null}
            <DropdownMenuItem onSelect={showHistory}>Decision history</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant={showFilters || filtersActive ? "secondary" : "ghost"} size="icon-sm" aria-label="Filter and search" aria-pressed={showFilters || filtersActive} onClick={() => setShowFilters((value) => !value)}><ListFilter className="size-4" /></Button>
      </div>
    </div>
    {view === "mine" ? null : <p className="text-sm text-muted-foreground">Showing <span className="font-medium text-foreground">{ATTENTION_VIEW_LABELS[view]}</span></p>}
    {/* Receipts collapse to one line until opened (PAP-770; PAP-749 plan §6). Not in the badge. */}
    {view === "mine" && (feed.data?.receipts?.length ?? 0) > 0 ? (
      receiptsOpen
        ? <AttentionReceiptList receipts={feed.data?.receipts ?? []} userLabelMap={userLabelMap} onOpen={navigate} onDismiss={receiptActions.dismiss} dismissingId={receiptActions.dismissingId} />
        : <button type="button" onClick={() => setReceiptsOpen(true)} className="flex w-full items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted"><Mail className="size-4 shrink-0" /><span className="font-medium text-foreground">{feed.data?.receipts?.length} updates</span>on your requests<ArrowUpRight className="ml-auto size-4" /></button>
    ) : null}
    {showFilters || filtersActive || currentItems.length > 10 ? <div role="toolbar" aria-label="Decisions controls" className="flex flex-wrap items-center gap-2">
      <ToolbarSearch query={query} onQueryChange={setQuery} label="Search decisions" placeholder="Search decisions or task IDs…" />
      <NativeSelect aria-label="Filter decisions by agent" value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)} className="w-auto"><option value="">All agents</option>{(agentQuery.data ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</NativeSelect>
      <NativeSelect aria-label="Filter decisions by project" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} className="w-auto"><option value="">All projects</option>{projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</NativeSelect>
      <NativeSelect aria-label="Group decisions" value={groupBy} onChange={(event) => setGroupBy(event.target.value as Group)} className="w-auto"><option value="none">No grouping</option><option value="task">By task</option><option value="agent">By agent</option><option value="project">By project</option></NativeSelect>
      <NativeSelect aria-label="Sort decisions" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} className="w-auto"><option value="newest">Newest first</option><option value="oldest">Oldest first</option></NativeSelect>
    </div> : null}
    {feed.isPending ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading decisions…</p> : null}
    {feed.isError ? <div role="alert" className="space-y-2"><p className="text-sm">Decisions could not be loaded.</p><Button variant="outline" onClick={() => void feed.refetch()}>Retry</Button></div> : null}
    {!feed.isPending && !feed.isError && currentItems.length === 0 ? <div className="space-y-3 py-8 text-center"><p className="text-sm text-muted-foreground">{staleItems.length ? "No current cards. Stale cards are below." : snoozedItems.length ? "No archived cards. Snoozed cards are below." : filtersActive && !visibleRecentItems.length ? "No decisions match these filters." : pendingItems.length ? "No open decisions match these filters." : EMPTY_VIEW_TEXT[view]}</p><Button variant="ghost" onClick={showHistory}>Open decision history<ArrowUpRight className="size-4" /></Button></div> : null}
    {groups.map(([label, items]) => <div key={label} className="space-y-4">{label ? <h2 className="text-sm font-medium text-muted-foreground">{label}</h2> : null}{items.map(renderCard)}</div>)}
    {currentItems.length > renderLimit ? <Button variant="outline" onClick={() => setRenderLimit((value) => value + 40)}>Show more decisions</Button> : null}
    <AttentionStaleGroup items={staleItems} open={staleOpen} onToggle={() => setStaleOpen(open => !open)} onWithdrawAll={closeActions.withdrawAll}
      busy={closeActions.bulkPending} currentUserId={userId} userLabelMap={userLabelMap} titleOf={coordinatorCardTitle}>
      {staleItems.map(renderCard)}
    </AttentionStaleGroup>
    {/* Snoozed by you: each card says when it comes back (PAP-749 plan §3). */}
    <AttentionSnoozedGroup count={snoozedItems.length} open={snoozedOpen} onToggle={() => setSnoozedOpen(open => !open)}>
      {snoozedItems.map(renderCard)}
    </AttentionSnoozedGroup>
    {visibleRecentItems.length || recentScope === "all" ? <section className="space-y-3" aria-label="Recent Decisions"><div className="flex items-center justify-between gap-2"><h2 className="text-sm font-medium text-muted-foreground">Recent Decisions</h2><NativeSelect aria-label="Whose recent decisions" value={recentScope} onChange={(event) => setRecentScope(event.target.value as DecisionHistoryScope)} className="w-auto">{DECISION_HISTORY_SCOPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</NativeSelect></div>{!visibleRecentItems.length ? <p className="text-sm text-muted-foreground">No decisions in the last day.</p> : null}{recentGroups.map(([label, items]) => <div key={label} className="space-y-3">{label ? <h3 className="text-sm font-medium text-muted-foreground">{label}</h3> : null}{items.map((item) => <motion.div layout={!reducedMotion} layoutId={reducedMotion ? undefined : item.id} transition={{ duration }} key={item.id}><Receipt item={item} onOpen={navigate} userLabelMap={userLabelMap} /></motion.div>)}</div>)}</section> : null}
    {recent.isError ? <p role="alert" className="text-sm text-muted-foreground">Recent decisions could not be loaded. <button className="underline" onClick={() => void recent.refetch()}>Retry</button></p> : null}
  </section></LayoutGroup>;
}
