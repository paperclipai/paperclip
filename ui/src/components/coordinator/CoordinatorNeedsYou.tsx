import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight, ChevronDown, FileText, Image as ImageIcon, Loader2 } from "lucide-react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { attentionCardType, type AttentionCloseMode, type AttentionItem, type AttentionPersonalView } from "@paperclipai/shared";
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
import { COORDINATOR_ASSIGNEE_PARAM, COORDINATOR_RECENT_DECISION_MS, DEFAULT_DECISION_HISTORY_SCOPE, coordinatorAssignee, coordinatorAssigneeTarget, coordinatorAudienceKey, coordinatorCardDetail, coordinatorCardTitle, recentDecisionReceipts, type CoordinatorAssignee } from "@/lib/coordinator-attention";
import { attentionDetailLine, isInlineResolvable } from "@/lib/attention";
import { ATTENTION_VIEW_PARAM, attentionAudienceLineNamesResponders, parseAttentionView } from "@/lib/attention-views";
import { splitArchivedAttentionItems, splitStaleAttentionItems } from "@/lib/attention-close";
import { attentionObligationEvidence, foldAttentionObligations } from "@/lib/attention-obligations";
import { buildCompanyUserLabelMap } from "@/lib/company-members";
import { AttentionCloseMenu, AttentionForOtherGate, AttentionHiddenChip, AttentionSnoozedGroup, AttentionStaleChip, AttentionStaleGroup } from "@/components/AttentionCloseMenu";
import { BudgetAlertActions, FailedRunActions } from "@/components/AttentionInlineVerbs";
import { AttentionInteractionResolver } from "@/components/AttentionInteractionResolver";
import { ApprovalResolver, JoinRequestResolver } from "@/components/AttentionQueueRow";
import { AttentionObligationEvidence } from "@/components/AttentionObligationEvidence";
import { DecisionHistoryPanel } from "@/components/DecisionHistoryPanel";
import { DecisionResolver } from "@/components/DecisionResolver";
import { DecisionCardFooter } from "@/components/DecisionCardFooter";
import { useSidePanelTabs } from "@/components/side-panel";
import { ToolbarSearch } from "@/components/ToolbarSearch";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { NativeSelect } from "@/components/ui/select";
import { parseCssTimeMs } from "@/components/task-chat/motion-tokens";
import { timeAgo } from "@/lib/timeAgo";
import { CoordinatorDecisionReceipt as Receipt } from "./CoordinatorDecisionReceipt";
import { CoordinatorTaskMotion } from "./CoordinatorTaskCommitment";
import { CoordinatorReviewPanel, needsYouArtifact, needsYouArtifactLabel, needsYouMentionedArtifact, type NeedsYouArtifact } from "./CoordinatorReviewPanel";
import { BlockedTaskCardBody, RecoveryCardBody, ReviewTaskCardBody } from "./NeedsYouCardBodies";
import { NEEDS_YOU_SECTIONS, NeedsYouPanelRow, needsYouSection, type NeedsYouSection } from "./NeedsYouCardKit";
import { NeedsYouAudience, NeedsYouReceiptCard, NeedsYouRequester, NeedsYouTaskLink, NeedsYouTypeLabel, needsYouTaskRef } from "./NeedsYouCardParts";
import { CoordinatorNeedsYouSidePanel, needsYouReviewTab, needsYouReviewTabId, needsYouTabArtifact, type NeedsYouReviewPayload } from "./CoordinatorNeedsYouSidePanel";

type Group = "type" | "none" | "task" | "agent" | "project";

/** Rule 7: a card that cannot answer inline links to the exact control, named by its verb. */
function openLabel(item: AttentionItem) {
  return (item.decisionVerbs ?? []).find((verb) => verb.id === "open_recovery" || verb.id === "inspect")?.label ?? "Open to review";
}

/** Say each thing once (IA4): a quoted excerpt of the title is not a second line. */
function sameText(left: string, right: string) {
  const plain = (text: string) => text.trim().replace(/^[“"']+|[”"']+$/g, "").replace(/[.\s]+$/, "").trim().toLocaleLowerCase();
  const a = plain(left);
  const b = plain(right);
  return a === b || b.includes(`“${a}”`.toLocaleLowerCase()) || b.endsWith(a);
}

/** A document key as a name ("email-draft" → "Email draft") until its title loads. */
function documentKeyLabel(key: string) {
  const words = key.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toLocaleUpperCase() + words.slice(1);
}

const EMPTY_VIEW_TEXT: Record<AttentionPersonalView, string> = {
  mine: "You're caught up.",
  unassigned: "No cards need an owner.",
  company: "No company alerts right now.",
  archived: "Nothing archived. Cards you archive or snooze for yourself show here.",
  all: "No open cards for anyone.",
};

export function CoordinatorNeedsYou() {
  const { selectedCompanyId } = useCompany();
  const { userId } = useCoordinatorWorkspaceEnabled();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openPanel, closePanel, panelVisible, setPanelVisible } = usePanel();
  const { isMobile } = useSidebar();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkDecisionId = searchParams.get("decisionId");
  // For you is the default; the other views live in the URL (PAP-749 Rule 3).
  // Everyone opens for a board member only (PAP-768).
  const everyone = useAttentionEveryoneView(selectedCompanyId);
  const view = parseAttentionView(searchParams.get(ATTENTION_VIEW_PARAM), { everyone });
  // Everyone can be narrowed to one person (PAP-775); the person lives in the URL too.
  const forUserId = view === "all" ? searchParams.get(COORDINATOR_ASSIGNEE_PARAM) : null;
  const setView = useCallback((next: typeof view, person: string | null = null) => setSearchParams(current => {
    const params = new URLSearchParams(current);
    if (next === "mine") params.delete(ATTENTION_VIEW_PARAM); else params.set(ATTENTION_VIEW_PARAM, next);
    if (person) params.set(COORDINATOR_ASSIGNEE_PARAM, person); else params.delete(COORDINATOR_ASSIGNEE_PARAM);
    return params;
  }, { replace: true }), [setSearchParams]);
  const assignee = coordinatorAssignee(view, forUserId);
  const reducedMotion = useReducedMotion();
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [groupBy, setGroupBy] = useState<Group>("type");
  const [historyOpen, setHistoryOpen] = useState(false);
  // Focus (PAP-770): documents a card asks about open as side-panel tabs, the
  // same chrome as task detail. Decision history is a main-pane view instead.
  const reviewTabs = useSidePanelTabs<NeedsYouReviewPayload>({ initialState: { tabs: [], activeTabId: null } });
  const [reviewPanelOpen, setReviewPanelOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [settling, setSettling] = useState<AttentionItem[]>([]);
  const [savedIds, setSavedIds] = useState<Map<string, { version: number; fingerprint: string; closed: boolean }>>(() => new Map());
  // The Stale (N) group starts collapsed in each view; the Archived view's
  // Snoozed group starts open (PAP-749 plan §3).
  const [staleOpen, setStaleOpen] = useState(false);
  const [snoozedOpen, setSnoozedOpen] = useState(true);
  useEffect(() => { setSettling([]); setSavedIds(new Map()); setStaleOpen(false); setSnoozedOpen(true); }, [selectedCompanyId, userId, view]);
  const archivedView = view === "archived";
  const [renderLimit, setRenderLimit] = useState(40);
  // Keyed by person and view; the For you key is the one the badge reads.
  const feed = useAttentionViewFeed(selectedCompanyId, view);
  useEffect(() => {
    setSavedIds(current => {
      const pending = new Map([...current].filter(([, hidden]) => hidden.closed || hidden.version === feed.dataUpdatedAt));
      return pending.size === current.size ? current : pending;
    });
  }, [feed.dataUpdatedAt]);
  const feedView = useQueryView(feed);
  const feedWaiting = feedView.kind === "loading" || feedView.kind === "reconnecting";
  const { viewCounts } = useAttentionBadge(selectedCompanyId);
  const claim = useClaimAttentionItem(selectedCompanyId);
  const receiptActions = useDismissAttentionReceipt(selectedCompanyId);
  const directory = useQuery({ queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!), queryFn: () => accessApi.listUserDirectory(selectedCompanyId!), enabled: !!selectedCompanyId });
  const userLabelMap = useMemo(() => buildCompanyUserLabelMap(directory.data?.users), [directory.data?.users]);
  // A closed card leaves the list at once; a withdrawn one comes back as a
  // receipt in Recent Decisions after the history refetch. In the Archived
  // view a new snooze time keeps the card (it only changes group), and a
  // restored card leaves it; elsewhere an Undo brings the card straight back.
  const hideCard = useCallback((item: AttentionItem, closed = false) => {
    setSavedIds(current => new Map(current).set(`${item.sourceKind}:${item.subject.id}`, { version: feed.dataUpdatedAt, fingerprint: item.changeFingerprint, closed }));
  }, [feed.dataUpdatedAt]);
  const showCard = useCallback((item: AttentionItem) => {
    setSavedIds(current => { const next = new Map(current); next.delete(`${item.sourceKind}:${item.subject.id}`); return next; });
  }, []);
  const onCardClosed = useCallback((item: AttentionItem, mode: AttentionCloseMode) => {
    if (archivedView && mode !== "withdraw") return;
    hideCard(item, mode === "withdraw");
  }, [archivedView, hideCard]);
  const onCardRestored = useCallback((item: AttentionItem) => (archivedView ? hideCard : showCard)(item), [archivedView, hideCard, showCard]);
  const closeActions = useAttentionCloseActions(selectedCompanyId, { userLabelMap, onClosed: onCardClosed, onRestored: onCardRestored });
  const agentQuery = useQuery({ queryKey: queryKeys.agents.list(selectedCompanyId!), queryFn: () => agentsApi.list(selectedCompanyId!), enabled: !!selectedCompanyId });
  // History has one home, the main-pane Decision history view (PAP-775, IA3/IA4).
  // The newest page is read here only so an answered card can turn into its
  // receipt in place before it leaves, and so a card already answered elsewhere
  // never shows twice.
  const recent = useQuery({ queryKey: [...queryKeys.attention(selectedCompanyId!), "history", "recent", DEFAULT_DECISION_HISTORY_SCOPE],
    queryFn: () => attentionApi.history(selectedCompanyId!, { limit: 100, scope: DEFAULT_DECISION_HISTORY_SCOPE, since: new Date(Date.now() - COORDINATOR_RECENT_DECISION_MS).toISOString() }), enabled: !!selectedCompanyId, refetchOnWindowFocus: true });
  const agentMap = useMemo(() => new Map((agentQuery.data ?? []).map((agent) => [agent.id, agent])), [agentQuery.data]);
  const recentItems = useMemo(() => recentDecisionReceipts(recent.data?.items ?? [], now), [recent.data, now]);
  const settlingIds = useMemo(() => new Set(settling.map(item => `${item.sourceKind}:${item.subject.id}`)), [settling]);
  // One card for each obligation (PAP-749 Rule 11): evidence folds into its
  // lead before the page hides, splits or groups anything.
  const obligations = useMemo(() => foldAttentionObligations(feed.data?.items ?? []), [feed.data]);
  const pendingItems = useMemo(() => {
    const receipts = new Set(recentItems.map((item) => item.id));
    const items = new Map(obligations.cards.map((item) => [`${item.sourceKind}:${item.subject.id}`, item]));
    for (const item of settling) if (!items.has(`${item.sourceKind}:${item.subject.id}`)) items.set(`${item.sourceKind}:${item.subject.id}`, item);
    return [...items].filter(([key, item]) => {
      const hidden = savedIds.get(key);
      const locallyHidden = hidden && (hidden.closed ? hidden.fingerprint === item.changeFingerprint : hidden.version === feed.dataUpdatedAt);
      return settlingIds.has(key) || (!receipts.has(key) && !locallyHidden);
    }).map(([, item]) => item);
  }, [obligations, settling, settlingIds, recentItems, savedIds, feed.dataUpdatedAt]);
  const filtered = useMemo(() => pendingItems.filter((item) => {
    const agentId = String(item.subject.metadata?.createdByAgentId ?? item.subject.metadata?.originAgentId ?? "");
    if (agentFilter && agentId !== agentFilter && item.originAgentName !== agentMap.get(agentFilter)?.name) return false;
    if (projectFilter && item.project?.id !== projectFilter) return false;
    if (forUserId && coordinatorAudienceKey(item) !== `user:${forUserId}`) return false;
    return [item.subject.title, item.relatedIssue?.title, item.relatedIssue?.identifier, item.originAgentName, item.project?.name, attentionDetailLine(item)].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  }).sort((a, b) => Date.parse(b.activityAt) - Date.parse(a.activityAt)), [pendingItems, agentFilter, projectFilter, forUserId, query, agentMap]);
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
      const label = groupBy === "type" ? needsYouSection(item) : groupBy === "task" ? item.relatedIssue?.identifier ?? item.relatedIssue?.title ?? "Other decisions"
        : groupBy === "agent" ? item.originAgentName ?? "Other agents" : groupBy === "project" ? item.project?.name ?? "No project" : "";
      result.set(label, [...(result.get(label) ?? []), item]);
    }
    // By type, decisions come before problems (Paper "A · Compact cards").
    return groupBy === "type" ? [...result].sort(([a], [b]) => (a === "decisions" ? 0 : 1) - (b === "decisions" ? 0 : 1)) : [...result];
  }, [currentItems, groupBy, renderLimit]);
  useEffect(() => {
    if (!deepLinkDecisionId || !selectedCompanyId) return;
    if (!pendingItems.some(item => item.sourceKind === "decision" && item.subject.id === deepLinkDecisionId)) {
      if (!feedWaiting && everyone && view !== "all") setView("all");
      return;
    }
    // A saved decision link takes precedence over local toolbar filters and the
    // rendering window. Consume it only after its actual card has mounted.
    if (query || agentFilter || projectFilter) { setQuery(""); setAgentFilter(""); setProjectFilter(""); return; }
    if (forUserId) { setView("all"); return; }
    if (staleItems.some(item => item.sourceKind === "decision" && item.subject.id === deepLinkDecisionId)) setStaleOpen(true);
    const index = currentItems.findIndex(item => item.sourceKind === "decision" && item.subject.id === deepLinkDecisionId);
    if (index >= renderLimit) { setRenderLimit(Math.ceil((index + 1) / 40) * 40); return; }
    const card = document.getElementById(`coordinator-decision-${deepLinkDecisionId}`);
    if (!card) return;
    card.focus({ preventScroll: true });
    card.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
    setSearchParams(current => { const next = new URLSearchParams(current); next.delete("decisionId"); return next; }, { replace: true });
  }, [deepLinkDecisionId, selectedCompanyId, pendingItems, currentItems, staleItems, feedWaiting, everyone, view, query, agentFilter, projectFilter, forUserId, setView, renderLimit, reducedMotion, setSearchParams]);
  const projects = useMemo(() => [...new Map([
    ...pendingItems.flatMap((item) => item.project ? [[item.project.id, item.project.name] as const] : []),
    ...recentItems.flatMap((item) => item.projectId ? [[item.projectId, item.projectName ?? "Unnamed project"] as const] : []),
  ]).entries()], [pendingItems, recentItems]);
  // Assigned to you, everyone the viewer may see, one person, no owner yet, or company alerts.
  const assigneeOptions = useMemo(() => {
    const people = [...userLabelMap].filter(([id]) => id !== userId).sort(([, a], [, b]) => a.localeCompare(b));
    return [
      { value: "me" as CoordinatorAssignee, label: "Assigned to you" },
      ...(everyone ? [{ value: "all" as CoordinatorAssignee, label: "All assignees" }, ...people.map(([id, name]) => ({ value: `user:${id}` as CoordinatorAssignee, label: name }))] : []),
      { value: "unassigned" as CoordinatorAssignee, label: "No owner yet" },
      { value: "company" as CoordinatorAssignee, label: "Company alerts" },
    ];
  }, [userLabelMap, userId, everyone]);
  const chooseAssignee = (value: CoordinatorAssignee) => { const target = coordinatorAssigneeTarget(value, userId); setView(target.view, target.forUserId); };
  const closeHistory = useCallback(() => setHistoryOpen(false), []);
  const showHistory = () => setHistoryOpen(true);
  // Cards whose artifact can open beside them: the + launcher lists these.
  const reviewable = useMemo(() => pendingItems.filter(item => !!needsYouArtifact(item)), [pendingItems]);
  const { openTab: openReviewTab, closeTab: closeReviewTab, selectTab: selectReviewTab, reorderTabs: reorderReviewTabs, resetTabs: resetReviewTabs } = reviewTabs;
  const showReview = useCallback((item: AttentionItem, artifact?: NeedsYouArtifact | null) => {
    openReviewTab(needsYouReviewTab(item, artifact));
    setReviewPanelOpen(true);
    setPanelVisible(true);
  }, [openReviewTab, setPanelVisible]);
  // The frame's close control hides the panel; its tabs come back with the next Review.
  useEffect(() => { if (!panelVisible) setReviewPanelOpen(false); }, [panelVisible]);
  // A resolved or closed card's tabs close with it.
  useEffect(() => {
    const open = new Set(pendingItems.map(item => item.id));
    for (const tab of reviewTabs.tabs) if (!open.has(tab.payload.itemId)) closeReviewTab(tab.id);
  }, [pendingItems, reviewTabs.tabs, closeReviewTab]);
  useEffect(() => { setBreadcrumbs([{ label: "Needs You" }]); }, [setBreadcrumbs]);
  useEffect(() => {
    setSettling([]); setHistoryOpen(false); setReviewPanelOpen(false); resetReviewTabs({ tabs: [], activeTabId: null }); setNow(Date.now()); closePanel();
    return closePanel;
  }, [selectedCompanyId, closePanel, resetReviewTabs]);
  useEffect(() => {
    if (!selectedCompanyId || isMobile || !reviewPanelOpen) { closePanel(); return; }
    openPanel(<CoordinatorNeedsYouSidePanel tabs={reviewTabs.tabs} activeTabId={reviewTabs.activeTabId} items={pendingItems} reviewable={reviewable}
      onSelectTab={selectReviewTab} onCloseTab={closeReviewTab} onReorderTabs={reorderReviewTabs} onOpenItem={item => showReview(item)}
      renderReview={(item, tab) => { const artifact = needsYouTabArtifact(item, tab.payload); return artifact ? <CoordinatorReviewPanel key={tab.id} companyId={selectedCompanyId} item={item} artifact={artifact}
        agentMap={agentMap} currentUserId={userId} userLabelMap={userLabelMap} onOpenTask={navigate} onResolved={() => closeReviewTab(tab.id)} /> : null; }} />);
  }, [reviewPanelOpen, reviewTabs.tabs, reviewTabs.activeTabId, pendingItems, reviewable, selectedCompanyId, isMobile, agentMap, userId, userLabelMap, navigate, openPanel, closePanel, selectReviewTab, closeReviewTab, reorderReviewTabs, showReview]);
  useEffect(() => {
    const next = recentItems.reduce((earliest, item) => Math.min(earliest, Date.parse(item.resolvedAt) + COORDINATOR_RECENT_DECISION_MS), Infinity);
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 1);
    return () => window.clearTimeout(timer);
  }, [recentItems]);
  const onResolved = (item: AttentionItem) => {
    const id = `${item.sourceKind}:${item.subject.id}`;
    hideCard(item, true);
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
    // PAP-775 (UX1): approvals and join requests are answered on the card.
    const approval = item.sourceKind === "approval" && isInlineResolvable(item);
    const joinRequest = item.sourceKind === "join_request" && isInlineResolvable(item);
    const taskRef = needsYouTaskRef(item);
    // null when there is no task, so the footer keeps its actions on the right (UI4).
    const taskLink = taskRef?.href ? <NeedsYouTaskLink task={taskRef} onOpen={navigate} /> : null;
    const id = `${item.sourceKind}:${item.subject.id}`;
    const receipt = settlingIds.has(id) ? recentItems.find(entry => entry.id === id) : undefined;
    const phase = !receipt ? "pending" : ["cancelled", "expired"].includes(receipt.outcome) ? "closed" : "resolved";
    const refetchAll = () => { void feed.refetch(); void recent.refetch(); };
    // Focus (PAP-770, PAP-775 IA5): a card about an artifact opens it beside the card.
    const artifact = isMobile ? null : needsYouArtifact(item);
    // The card stays highlighted while any of its artifacts is open beside it (UI9).
    const panelOpen = !isMobile && reviewPanelOpen && panelVisible;
    const activeTab = panelOpen ? reviewTabs.tabs.find(tab => tab.id === reviewTabs.activeTabId) : undefined;
    const reviewing = !!activeTab && activeTab.payload.itemId === item.id;
    const reviewingOwn = !!artifact && panelOpen && reviewTabs.activeTabId === needsYouReviewTabId(item);
    // The artifact opens beside the card from the first row of its context panel (IA5).
    const artifactRow = artifact && artifact.kind !== "approval" ? <NeedsYouPanelRow
      icon={artifact.kind === "images" ? <ImageIcon /> : <FileText />}
      title={artifact.kind === "document" && !artifact.title ? (artifact.key === "plan" ? "Plan" : documentKeyLabel(artifact.key)) : needsYouArtifactLabel(artifact)}
      meta={reviewingOwn ? "Open in sidebar · Showing" : "Open in sidebar"}
      label={`${reviewingOwn ? "Close" : "Open"} ${needsYouArtifactLabel(artifact)} in the sidebar`}
      onOpen={() => reviewingOwn ? closeReviewTab(needsYouReviewTabId(item)) : showReview(item)} /> : null;
    // A plan, document, approval or attachment the card links to opens as a
    // side-panel tab beside the card, not a page change (PAP-775, IA5).
    // A modified click still opens the link itself.
    const openMentionedDocument = (event: ReactMouseEvent) => {
      if (isMobile || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      const link = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
      const mentioned = link ? needsYouMentionedArtifact(link.getAttribute("href")!, link.textContent) : null;
      if (!mentioned) return;
      event.preventDefault();
      showReview(item, mentioned);
    };
    const title = coordinatorCardTitle(item);
    const detail = coordinatorCardDetail(item, attentionDetailLine(item));
    // The ask, with one plain line under it (UI1).
    const heading = <div className="space-y-1.5"><h2>{title}</h2>{detail && !sameText(detail, title) ? <p className="text-sm text-muted-foreground">{detail}</p> : null}</div>;
    const footerContext = <AttentionObligationEvidence item={item} evidence={attentionObligationEvidence(obligations, item)} />;
    const type = attentionCardType(item);
    return <motion.div id={item.sourceKind === "decision" ? `coordinator-decision-${item.subject.id}` : undefined} tabIndex={item.sourceKind === "decision" ? -1 : undefined} layout={reducedMotion ? false : "position"} layoutId={reducedMotion ? undefined : id} transition={{ duration }} key={id}>
    <CoordinatorTaskMotion eventId={`decision:${selectedCompanyId}:${userId}:${id}`} phase={phase} createdAt={item.activityAt} className="coordinator-decision-motion"
      onSettled={() => setSettling(current => current.filter(entry => `${entry.sourceKind}:${entry.subject.id}` !== id))}>
    {receipt ? <Receipt item={receipt} onOpen={navigate} userLabelMap={userLabelMap} /> : <article onClickCapture={openMentionedDocument}
      className="coordinator-decision-card space-y-3"
      data-attention-card={item.id} data-card-type={type} data-card-kind={needsYouSection(item) === "problems" ? "problem" : "decision"} data-reviewing={reviewing || undefined}>
      {/* What to do (with whose card it is) on the left; who asked, when, and ⋯ on the right (Paper "A · Compact cards"). */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          <NeedsYouTypeLabel item={item} currentUserId={userId} userLabelMap={userLabelMap} />
          <AttentionHiddenChip item={item} />
          <AttentionStaleChip item={item} />
        </div>
        <div className="flex shrink-0 items-center gap-3" data-attention-context>
          <NeedsYouAudience item={item} currentUserId={userId} userLabelMap={userLabelMap} onClaim={entry => claim.mutate(entry)} claiming={claim.isPending && claim.variables?.id === item.id} />
          <NeedsYouRequester item={item} agentMap={agentMap} userLabelMap={userLabelMap} currentUserId={userId} />
          <time dateTime={item.activityAt} title={new Date(item.activityAt).toLocaleString()} className="shrink-0 text-xs leading-4.5 text-muted-foreground">{timeAgo(item.activityAt)}</time>
          <AttentionCloseMenu item={item} currentUserId={userId} userLabelMap={userLabelMap}
          busy={closeActions.closingItemId === item.id || closeActions.transferringItemId === item.id}
          onWithdraw={(entry, reason) => closeActions.close({ item: entry, mode: "withdraw", reason })}
          onArchive={entry => closeActions.close({ item: entry, mode: "archive" })}
          onSnooze={(entry, until) => closeActions.close({ item: entry, mode: "snooze", until })}
          onTransfer={(entry, target) => closeActions.transfer({ item: entry, userId: target })}
          onRestore={archivedView ? entry => void closeActions.restore(entry) : undefined} />
        </div>
      </div>
      <AttentionForOtherGate item={item} currentUserId={userId} userLabelMap={userLabelMap}>
      {interaction ? <AttentionInteractionResolver footerSlot={taskLink} artifactRow={artifactRow} presentation="coordinator-decision" audienceStated={attentionAudienceLineNamesResponders(item, userId)} companyId={selectedCompanyId!} issueId={issueId} interactionId={item.subject.id} shareReviseDraft agentMap={agentMap} currentUserId={userId} onResolved={resolved => {
        if (!resolved || resolved.status === "pending") { refetchAll(); return; }
        onResolved(item);
      }} />
        : decision ? <DecisionResolver companyId={selectedCompanyId!} decisionId={item.subject.id} originIssue={item.relatedIssue} agentMap={agentMap} leading={taskLink} onResolved={() => onResolved(item)} />
        : stalledReview ? <><div className="space-y-1.5"><h2>Choose how this task continues</h2><p className="text-sm text-muted-foreground">This task is still in review with no active reviewer or continuation. Return it to work, request changes, or mark the task done.</p></div><BlockedTaskCardBody item={item} companyId={selectedCompanyId!} agentMap={agentMap} userLabelMap={userLabelMap} leading={taskLink} footerContext={footerContext} onOpen={navigate} onResolved={refetchAll} /></>
        : failedRun ? <>{heading}<FailedRunActions item={item} companyId={selectedCompanyId!} leading={taskLink} footerContext={footerContext} presentation="card" onResolved={refetchAll} /></>
        : budget ? <>{heading}<BudgetAlertActions item={item} companyId={selectedCompanyId!} leading={taskLink} footerContext={footerContext} presentation="card" onResolved={refetchAll} /></>
        : approval ? <>{heading}<ApprovalResolver item={item} companyId={selectedCompanyId!} toggle={taskLink} footerContext={footerContext} presentation="card" onViewDetails={isMobile ? undefined : () => showReview(item)} shareDraft onResolved={() => onResolved(item)} /></>
        : joinRequest ? <>{heading}<JoinRequestResolver item={item} companyId={selectedCompanyId!} toggle={taskLink} presentation="card" onResolved={() => onResolved(item)} /></>
        : type === "review_task" ? <>{heading}<ReviewTaskCardBody item={item} companyId={selectedCompanyId!} agentMap={agentMap} userLabelMap={userLabelMap} leading={taskLink} footerContext={footerContext} onOpen={navigate} onResolved={refetchAll} /></>
        : type === "blocked_task" ? <>{heading}<BlockedTaskCardBody item={item} companyId={selectedCompanyId!} agentMap={agentMap} userLabelMap={userLabelMap} leading={taskLink} footerContext={footerContext} onOpen={navigate} onResolved={refetchAll} /></>
        : type === "recovery" ? <>{heading}<RecoveryCardBody item={item} companyId={selectedCompanyId!} leading={taskLink} footerContext={footerContext} onOpen={navigate} onResolved={refetchAll} /></>
        : <>{heading}{footerContext}<DecisionCardFooter leading={taskLink}><Button disabled={!item.subject.href} onClick={() => { if (item.subject.href) navigate(item.subject.href); }}>{openLabel(item)}<ArrowUpRight className="size-4" /></Button></DecisionCardFooter></>}
      </AttentionForOtherGate>
    </article>}
    </CoordinatorTaskMotion>
    </motion.div>;
  };
  if (!selectedCompanyId) return <p className="text-sm text-muted-foreground">Choose a company to see its decisions.</p>;
  // Decision history is a view of the main pane (PAP-770), not a side panel
  // that repeats Recent Decisions beside them.
  if (historyOpen) return <section className="coordinator-needs-you mx-auto w-full max-w-4xl space-y-6" aria-label="Decision history" data-coordinator-decision-history>
    <Button variant="ghost" size="sm" onClick={closeHistory}><ArrowLeft className="size-4" />Needs You</Button>
    <DecisionHistoryPanel companyId={selectedCompanyId} agents={agentQuery.data ?? []} userLabelMap={userLabelMap} header={<h1 className="text-2xl font-medium">Decision history</h1>} />
  </section>;
  const receipts = view === "mine" ? feed.data?.receipts ?? [] : [];
  const counts = { decisions: 0, problems: 0, updates: receipts.length };
  for (const item of currentItems) counts[needsYouSection(item)]++;
  const summarySections = (Object.keys(counts) as NeedsYouSection[]).filter(section => counts[section] > 0);
  if (!summarySections.length) summarySections.push("decisions");
  const sectionHeading = (section: NeedsYouSection) => <h2 className="text-base font-medium" data-needs-you-section={section}>
    {NEEDS_YOU_SECTIONS[section].title}
  </h2>;
  return <LayoutGroup id="coordinator-decisions"><section className="coordinator-needs-you mx-auto w-full max-w-4xl space-y-6" aria-label="Needs You">
    {archivedView ? <div className="flex items-center gap-2"><Button variant="ghost" size="icon-sm" aria-label="Back to Needs You" onClick={() => setView("mine")}><ArrowLeft className="size-4" /></Button><h1 className="text-2xl font-medium">Archived</h1></div> : null}
    {/* Assigned to you by default (PAP-775); the assignee filter widens to all
        assignees, one person, no owner yet or company alerts. Archived and
        Decision history sit in View. */}
    <div role="toolbar" aria-label="Decisions controls" className="flex flex-wrap items-center gap-2">
      <div className="min-w-44 flex-1"><ToolbarSearch query={query} onQueryChange={setQuery} label="Search decisions" placeholder="Search…" /></div>
      <NativeSelect aria-label="Filter decisions by agent" value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)} className="w-auto"><option value="">All agents</option>{(agentQuery.data ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</NativeSelect>
      <NativeSelect aria-label="Filter decisions by project" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} className="w-auto"><option value="">All projects</option>{projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</NativeSelect>
      {assignee ? <NativeSelect aria-label="Filter decisions by assignee" data-attention-assignee={assignee} value={assignee} onChange={(event) => chooseAssignee(event.target.value as CoordinatorAssignee)} className="w-auto">
        {assigneeOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        {assignee.startsWith("user:") && !assigneeOptions.some(option => option.value === assignee) ? <option value={assignee}>Someone else</option> : null}
      </NativeSelect> : null}
      <NativeSelect aria-label="Group decisions" value={groupBy} onChange={(event) => setGroupBy(event.target.value as Group)} className="w-auto"><option value="type">By type</option><option value="task">By task</option><option value="agent">By agent</option><option value="project">By project</option><option value="none">No grouping</option></NativeSelect>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" data-attention-view-menu>View<ChevronDown className="size-4" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setView("archived")}>Archived{viewCounts.archived ? ` · ${viewCounts.archived}` : ""}</DropdownMenuItem>
          <DropdownMenuItem onSelect={showHistory}>Decision history</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    {feed.data ? <p className="text-sm text-muted-foreground" data-needs-you-summary>
      {summarySections.map((section, index) => {
        const label = NEEDS_YOU_SECTIONS[section].title.toLocaleLowerCase();
        return <span key={section}>{index ? " · " : ""}{counts[section]} {counts[section] === 1 ? label.slice(0, -1) : label}</span>;
      })}
    </p> : null}
    {feedWaiting ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading decisions…</p> : null}
    {feedView.kind === "error" ? <QueryErrorState error={feedView.error} onRetry={feedView.retry} /> : null}
    {!feedWaiting && feedView.kind !== "error" && currentItems.length === 0 && !receipts.length ? <div className="space-y-3 py-8 text-center"><p className="text-sm text-muted-foreground">{staleItems.length ? "No current cards. Stale cards are below." : snoozedItems.length ? "No archived cards. Snoozed cards are below." : pendingItems.length ? "No open decisions match these filters." : EMPTY_VIEW_TEXT[view]}</p></div> : null}
    {groups.map(([label, items], index) => <div key={label} className="space-y-3" role={groupBy === "type" ? "group" : undefined} aria-label={groupBy === "type" ? NEEDS_YOU_SECTIONS[label as NeedsYouSection].title : undefined}>
      {groupBy === "type" ? index > 0 ? sectionHeading(label as NeedsYouSection) : null : label ? <h2 className="text-sm font-medium text-muted-foreground">{label}</h2> : null}
      {items.map(renderCard)}
    </div>)}
    {currentItems.length > renderLimit ? <Button variant="outline" onClick={() => setRenderLimit((value) => value + 40)}>Show more decisions</Button> : null}
    <AttentionStaleGroup items={staleItems} open={staleOpen} onToggle={() => setStaleOpen(open => !open)} onWithdrawAll={closeActions.withdrawAll}
      busy={closeActions.bulkPending} currentUserId={userId} userLabelMap={userLabelMap} titleOf={coordinatorCardTitle}>
      {staleItems.map(renderCard)}
    </AttentionStaleGroup>
    {/* Snoozed by you: each card says when it comes back (PAP-749 plan §3). */}
    <AttentionSnoozedGroup count={snoozedItems.length} open={snoozedOpen} onToggle={() => setSnoozedOpen(open => !open)}>
      {snoozedItems.map(renderCard)}
    </AttentionSnoozedGroup>
    {/* What other people did with your requests (PAP-749 plan §6): not in the badge. */}
    {receipts.length ? <div className="space-y-3" aria-label="Updates">
      {currentItems.length || staleItems.length || snoozedItems.length ? sectionHeading("updates") : null}
      {receipts.map(entry => <NeedsYouReceiptCard key={entry.id} receipt={entry} userLabelMap={userLabelMap} onOpen={navigate}
        onDismiss={receiptActions.dismiss} dismissing={receiptActions.dismissingId === entry.id} />)}
    </div> : null}
  </section></LayoutGroup>;
}
