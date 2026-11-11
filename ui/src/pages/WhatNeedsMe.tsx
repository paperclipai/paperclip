import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCoordinatorWorkspaceEnabled } from "../hooks/useCoordinatorWorkspaceEnabled";
import { CoordinatorNeedsYou } from "../components/coordinator/CoordinatorNeedsYou";
import { CheckCircle2, History, Inbox } from "lucide-react";
import type { Agent, AttentionItem, AttentionPersonalView, AttentionSubject } from "@paperclipai/shared";
import { useNavigate, useSearchParams } from "@/lib/router";
import { accessApi } from "../api/access";
import { attentionApi } from "../api/attention";
import { agentsApi } from "../api/agents";
import { decisionsApi } from "../api/decisions";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useAttentionBadge, useAttentionCloseActions, useAttentionEveryoneView, useClaimAttentionItem, useDismissAttentionReceipt } from "../hooks/useAttentionViews";
import { ATTENTION_VIEW_PARAM, parseAttentionView } from "../lib/attention-views";
import { buildCompanyUserLabelMap } from "../lib/company-members";
import { AttentionReceiptList, AttentionUnassignedBanner, AttentionViewSwitch } from "../components/AttentionViews";
import { AttentionSnoozedGroup, AttentionStaleGroup } from "../components/AttentionCloseMenu";
import { DecisionHistoryPanel } from "../components/DecisionHistoryPanel";
import { Button } from "../components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../components/ui/sheet";
import { splitArchivedAttentionItems } from "../lib/attention-close";
import { attentionObligationEvidence, foldAttentionObligations } from "../lib/attention-obligations";
import { queryKeys } from "../lib/queryKeys";
import {
  ATTENTION_AGING_DAYS,
  attentionIsAging,
  buildAttentionFilterOptions,
  defaultAttentionFilterState,
  filterAttentionItems,
  groupAttentionItems,
  isInlineResolvable,
  loadAttentionFilters,
  loadAttentionGroupBy,
  loadAttentionSortOrder,
  loadCollapsedAttentionGroupKeys,
  buildDeskShelves,
  planAttentionRenderRows,
  resolveAttentionDateRange,
  saveAttentionFilters,
  saveAttentionGroupBy,
  saveAttentionSortOrder,
  saveCollapsedAttentionGroupKeys,
  sortAttentionItems,
  type AttentionDateRangeId,
  type AttentionFilterState,
  type AttentionGroup,
  type AttentionGroupBy,
  type AttentionSortOrder,
} from "../lib/attention";
import { hasBlockingShortcutDialog, resolveAttentionQueueKeyAction } from "../lib/keyboardShortcuts";
import { PageSkeleton } from "../components/PageSkeleton";
import { QueryErrorState, useQueryView } from "../components/QueryView";
import { AttentionQueueRow } from "../components/AttentionQueueRow";
import { DecisionsToolbar } from "../components/DecisionsToolbar";
import { Curtain, AgingItemRow } from "../components/DecisionShelf";
import { DecisionQueueRail } from "../components/DecisionQueueRail";
import { DecisionDateChips, type AttentionCustomRange } from "../components/DecisionDateChips";
import { DecisionResolver } from "../components/DecisionResolver";
import { IssueGroupHeader } from "../components/IssueGroupHeader";

// Incremental rendering (PAP-13784, same pattern as IssuesList): the feed is
// uncapped, so mounting every row up front makes the page slow to paint and
// scroll. Render a bounded window and grow it as the scroll position nears the
// bottom. One budget spans the active groups and the open curtains in document
// order, so everything below the fold stays unmounted until needed.
const INITIAL_ATTENTION_ROW_RENDER_LIMIT = 50;
const ATTENTION_ROW_RENDER_BATCH_SIZE = 100;
const ATTENTION_SCROLL_LOAD_THRESHOLD_PX = 480;
const DECISION_HISTORY_VISIBLE_LIMIT = 50;
const DECISION_HISTORY_QUERY_LIMIT = DECISION_HISTORY_VISIBLE_LIMIT + 1;

export function decisionHistoryQueryEnabled(companyId: string | null | undefined, open: boolean) {
  return Boolean(companyId && open);
}

export function decisionHistoryCount(count: number | undefined) {
  if (count == null) return undefined;
  return count > DECISION_HISTORY_VISIBLE_LIMIT ? `${DECISION_HISTORY_VISIBLE_LIMIT}+` : count;
}

function findScrollContainer(element: HTMLElement | null): HTMLElement | null {
  if (!element || typeof window === "undefined") return null;
  let current = element.parentElement;
  while (current && current !== document.body && current !== document.documentElement) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

export function WhatNeedsMe() {
  const { enabled } = useCoordinatorWorkspaceEnabled();
  return enabled ? <CoordinatorNeedsYou /> : <ClassicWhatNeedsMe />;
}

function ClassicWhatNeedsMe() {
  const { selectedCompanyId } = useCompany();
  // The signed-in person; it keys every list so an account switch never shows
  // the previous person's cards (PAP-749 plan §1).
  const { userId: currentUserId } = useCoordinatorWorkspaceEnabled();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedAttentionId, setSelectedAttentionId] = useState<string | null>(null);
  // How the current selection was made. The selection ring is the keyboard
  // cursor — it marks the row that j/k, e, x and s will act on — so it is drawn
  // only for a keyboard-driven selection. Clicking used to set it too, which
  // put a ring around the card for no reason the operator could act on, and
  // only ever on rows with a See more/less toggle to click (the toggle is what
  // set it), so the queue looked arbitrarily inconsistent. The selection itself
  // still follows a click, so keyboard actions target the row you just used.
  const [selectionFromKeyboard, setSelectionFromKeyboard] = useState(false);
  const [autoExpandDone, setAutoExpandDone] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Toolbar preferences (persisted to localStorage, Inbox pattern).
  const [groupBy, setGroupBy] = useState<AttentionGroupBy>(() => loadAttentionGroupBy());
  const [sortOrder, setSortOrder] = useState<AttentionSortOrder>(() => loadAttentionSortOrder());
  const [filters, setFilters] = useState<AttentionFilterState>(() => defaultAttentionFilterState);
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(() => new Set());
  // The Archived view's Snoozed group starts open (PAP-749 plan §3).
  const [snoozedOpen, setSnoozedOpen] = useState(true);
  const [agingOpen, setAgingOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // The Stale (N) group starts collapsed (PAP-749 plan §3).
  const [staleOpen, setStaleOpen] = useState(false);
  const [decidedOpen, setDecidedOpen] = useState(false);
  const [expiredOpen, setExpiredOpen] = useState(false);

  // Date-range chips (PAP-16032 §4.2) — resolve to server-side activity bounds.
  const [dateRange, setDateRange] = useState<AttentionDateRangeId>("all");
  const [customRange, setCustomRange] = useState<AttentionCustomRange>({ from: null, to: null });

  // `?decisionId=` deep link (PAP-16032 §4.7) — focus/expand the referenced card.
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkDecisionId = searchParams.get("decisionId");
  const [deepLinkConsumed, setDeepLinkConsumed] = useState(false);
  // For you is the default; the other views live in the URL (PAP-749 Rule 3).
  // Everyone opens for a board member only (PAP-768).
  const everyone = useAttentionEveryoneView(selectedCompanyId);
  const view = parseAttentionView(searchParams.get(ATTENTION_VIEW_PARAM), { everyone });
  const setView = useCallback((next: AttentionPersonalView) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (next === "mine") params.delete(ATTENTION_VIEW_PARAM);
      else params.set(ATTENTION_VIEW_PARAM, next);
      return params;
    }, { replace: true });
  }, [setSearchParams]);
  // Archived: the cards you archived or snoozed for yourself (PAP-749 plan §3).
  const archivedView = view === "archived";
  const { viewCounts } = useAttentionBadge(selectedCompanyId);
  const claim = useClaimAttentionItem(selectedCompanyId);
  const claimingId = claim.isPending ? claim.variables?.id ?? null : null;
  const handleClaim = useCallback((item: AttentionItem) => claim.mutate(item), [claim.mutate]);

  // Optimistic hide. Reset whenever a fresh feed lands (server truth).
  const [pendingHide, setPendingHide] = useState<Set<string>>(() => new Set());

  const navigate = useNavigate();

  // Date chips resolve to server-side activity bounds. Anchored to start-of-day,
  // so the resolved ISO strings are stable across renders within the same day —
  // safe to key the feed query on without thrashing.
  const activityBounds = useMemo(
    () => resolveAttentionDateRange(dateRange, Date.now(), customRange),
    [dateRange, customRange],
  );

  useEffect(() => {
    setBreadcrumbs([{ label: "Decisions" }]);
  }, [setBreadcrumbs]);

  // Re-hydrate per-company preferences when the company changes.
  useEffect(() => {
    setFilters(loadAttentionFilters(selectedCompanyId));
    setCollapsedGroupKeys(loadCollapsedAttentionGroupKeys(selectedCompanyId));
  }, [selectedCompanyId]);

  const feedQuery = useQuery({
    // Distinct from the sidebar badge's `queryKeys.attention` so dismissed rows
    // (needed for the curtains) never inflate the badge count. Invalidating the
    // `["attention", companyId]` prefix still cascades to this query.
    queryKey: [
      ...queryKeys.attention(selectedCompanyId!),
      currentUserId,
      view,
      "classic",
      activityBounds.activitySince ?? null,
      activityBounds.activityUntil ?? null,
    ],
    queryFn: () => attentionApi.list(selectedCompanyId!, {
      all: true,
      view,
      ...activityBounds,
    }),
    enabled: !!selectedCompanyId && !!currentUserId,
    refetchOnWindowFocus: true,
  });
  const { data: feed, isLoading } = feedQuery;
  const feedView = useQueryView(feedQuery);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Decision history — decided / expired decisions leave the open attention
  // feed (entryRule = open only), so we fetch them directly for the curtains.
  const { data: decidedDecisions, isLoading: decidedDecisionsLoading } = useQuery({
    queryKey: queryKeys.decisions.list(selectedCompanyId!, "decided"),
    queryFn: () => decisionsApi.list(selectedCompanyId!, { status: "decided", limit: DECISION_HISTORY_QUERY_LIMIT }),
    enabled: decisionHistoryQueryEnabled(selectedCompanyId, decidedOpen),
  });
  const { data: expiredDecisions, isLoading: expiredDecisionsLoading } = useQuery({
    queryKey: queryKeys.decisions.list(selectedCompanyId!, "expired"),
    queryFn: () => decisionsApi.list(selectedCompanyId!, { status: "expired", limit: DECISION_HISTORY_QUERY_LIMIT }),
    enabled: decisionHistoryQueryEnabled(selectedCompanyId, expiredOpen),
  });

  const { data: userDirectory } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const userLabelMap = useMemo(() => buildCompanyUserLabelMap(userDirectory?.users), [userDirectory?.users]);

  // Every Close… verb goes through the one close API (PAP-749 plan §2). The row
  // hides at once; it comes back if the server refuses.
  const unhide = useCallback((item: AttentionItem) => {
    setPendingHide((prev) => {
      const next = new Set(prev);
      next.delete(item.id);
      return next;
    });
  }, []);
  const closeActions = useAttentionCloseActions(selectedCompanyId, { userLabelMap, onCloseFailed: unhide });
  const receiptActions = useDismissAttentionReceipt(selectedCompanyId);
  const closeCard = closeActions.close;
  const transferCard = closeActions.transfer;
  const closingId = closeActions.closingItemId ?? closeActions.transferringItemId;

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents ?? []) map.set(agent.id, agent);
    return map;
  }, [agents]);

  // Reset optimistic state once the server sends a fresh snapshot.
  useEffect(() => {
    setPendingHide(new Set());
  }, [feed?.generatedAt]);

  // One card for each obligation (PAP-749 Rule 11): evidence folds into its
  // lead before any split, so a lead and its evidence always move together.
  const obligations = useMemo(() => foldAttentionObligations(feed?.items ?? []), [feed]);
  const allItems = obligations.cards;

  const activeItems = useMemo(
    () => allItems.filter((item) => !pendingHide.has(item.id)),
    [allItems, pendingHide],
  );

  // The server's clock at feed time — used for the arrival/decide-by shelves and
  // the aging idle labels so they match `deskBadgeCount` and the sidebar badge
  // exactly, and stay stable across renders (Date.now() only as a pre-load fallback).
  const now = useMemo(
    () => (feed?.generatedAt ? new Date(feed.generatedAt).getTime() : Date.now()),
    [feed?.generatedAt],
  );

  // Stale cards (PAP-749 Rule 10) go to the collapsed Stale group at the bottom.
  // Aging shelf (§4.4): other items the server flags as idle past retention
  // leave the live desk for their own curtain, so the desk shows fresh decisions.
  // The Archived view (plan §3) keeps stale cards in place with their chip and
  // puts snoozed cards in their own group.
  const { staleItems, agingItems, deskItems, snoozedItems } = useMemo(() => {
    if (archivedView) {
      const { archived, snoozed } = splitArchivedAttentionItems(activeItems);
      return { staleItems: [], agingItems: [], deskItems: archived, snoozedItems: snoozed };
    }
    return {
      staleItems: activeItems.filter((item) => item.stale),
      agingItems: activeItems.filter((item) => !item.stale && attentionIsAging(item)),
      deskItems: activeItems.filter((item) => !item.stale && !attentionIsAging(item)),
      snoozedItems: [] as AttentionItem[],
    };
  }, [activeItems, archivedView]);

  const filterOptions = useMemo(() => buildAttentionFilterOptions(deskItems), [deskItems]);

  // Filter → sort → group, all client-side so switching re-buckets without a
  // refetch. In the default (ungrouped) view the desk groups by arrival —
  // "New today" then "Earlier" — with a "Decide now" shelf only when something
  // carries an explicit, due decide-by. Any explicit
  // group-by keeps the Inbox-style activity grouping.
  const groups = useMemo<AttentionGroup[]>(() => {
    const filtered = filterAttentionItems(deskItems, filters, searchQuery);
    if (groupBy === "none") {
      return buildDeskShelves(filtered, now);
    }
    const sorted = sortAttentionItems(filtered, sortOrder);
    return groupAttentionItems(sorted, groupBy);
  }, [deskItems, filters, searchQuery, sortOrder, groupBy, now]);

  const visibleStaleItems = useMemo(
    () => sortAttentionItems(filterAttentionItems(staleItems, filters, searchQuery), sortOrder),
    [staleItems, filters, searchQuery, sortOrder],
  );

  const visibleCount = useMemo(() => groups.reduce((sum, group) => sum + group.items.length, 0), [groups]);
  const keyboardItems = useMemo(
    () => groups.filter((group) => group.label === null || !collapsedGroupKeys.has(group.key)).flatMap((group) => group.items),
    [collapsedGroupKeys, groups],
  );

  // Rendered-row budget: only ratchets up (a hard reset mid-scroll would yank
  // the DOM out from under the user), and resets when the company changes.
  const [renderedRowLimit, setRenderedRowLimit] = useState(INITIAL_ATTENTION_ROW_RENDER_LIMIT);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setRenderedRowLimit(INITIAL_ATTENTION_ROW_RENDER_LIMIT);
  }, [selectedCompanyId]);

  // Keyboard selection may point past the budget (e.g. wrapping to the last
  // row), so the effective limit is derived to always cover it — the selected
  // row is then guaranteed to be in the DOM in the same commit that selects it.
  const renderPlan = useMemo(() => {
    const selectedIndex = selectedAttentionId
      ? keyboardItems.findIndex((item) => item.id === selectedAttentionId)
      : -1;
    return planAttentionRenderRows({
      groups,
      collapsedGroupKeys,
      snoozedItems,
      snoozedOpen,
      dismissedItems: [],
      dismissedOpen: false,
      limit: Math.max(renderedRowLimit, selectedIndex + 1),
    });
  }, [
    collapsedGroupKeys,
    groups,
    keyboardItems,
    renderedRowLimit,
    selectedAttentionId,
    snoozedItems,
    snoozedOpen,
  ]);

  const loadMoreRows = useCallback(() => {
    setRenderedRowLimit((current) => current + ATTENTION_ROW_RENDER_BATCH_SIZE);
  }, []);

  useEffect(() => {
    if (!renderPlan.hasMoreRows) return;
    let animationFrameId: number | null = null;
    const scrollContainer = findScrollContainer(rootRef.current);
    const scrollTarget: Window | HTMLElement = scrollContainer ?? window;

    const checkScrollPosition = () => {
      if (animationFrameId !== null) return;
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        const scrollHeight = scrollContainer?.scrollHeight ?? document.documentElement.scrollHeight;
        if (scrollHeight === 0) return;
        const scrollBottom = scrollContainer
          ? scrollContainer.scrollTop + scrollContainer.clientHeight
          : window.scrollY + window.innerHeight;
        if (scrollBottom >= scrollHeight - ATTENTION_SCROLL_LOAD_THRESHOLD_PX) {
          loadMoreRows();
        }
      });
    };

    scrollTarget.addEventListener("scroll", checkScrollPosition, { passive: true });
    window.addEventListener("resize", checkScrollPosition);
    // Initial check: a tall viewport (or an opened curtain) may need more rows
    // than the current budget before any scrolling happens.
    checkScrollPosition();

    return () => {
      scrollTarget.removeEventListener("scroll", checkScrollPosition);
      window.removeEventListener("resize", checkScrollPosition);
      if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
    };
  }, [loadMoreRows, renderPlan.hasMoreRows, renderedRowLimit]);

  useEffect(() => {
    if (selectedAttentionId && !keyboardItems.some((item) => item.id === selectedAttentionId)) {
      setSelectedAttentionId(null);
      setSelectionFromKeyboard(false);
    }
  }, [keyboardItems, selectedAttentionId]);

  useEffect(() => {
    if (!selectedAttentionId) return;
    document.getElementById(`attention-row-${selectedAttentionId}`)?.scrollIntoView({ block: "nearest" });
  }, [selectedAttentionId]);

  // `?decisionId=` deep link (§4.7): focus and expand the referenced decision
  // card once the feed lands, then drop the param so a later manual collapse is
  // not re-forced on the next refetch. Wins over the generic auto-expand below.
  useEffect(() => {
    if (deepLinkConsumed || !deepLinkDecisionId || isLoading) return;
    const target = allItems.find(
      (item) => item.sourceKind === "decision" && item.subject.id === deepLinkDecisionId,
    );
    if (!target) {
      if (everyone && view !== "all") setView("all");
      return;
    }
    setDeepLinkConsumed(true);
    setAutoExpandDone(true);
    if (target) {
      setExpandedId(target.id);
      setSelectedAttentionId(target.id);
      setSelectionFromKeyboard(true);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("decisionId");
          return next;
        },
        { replace: true },
      );
    }
  }, [allItems, deepLinkConsumed, deepLinkDecisionId, setSearchParams, isLoading, everyone, view, setView]);

  // Auto-expand the topmost inline-capable decision, once.
  useEffect(() => {
    if (autoExpandDone || deskItems.length === 0) return;
    const sorted = sortAttentionItems(deskItems, sortOrder);
    const topInline = sorted.find((item) => isInlineResolvable(item));
    if (topInline) setExpandedId(topInline.id);
    setAutoExpandDone(true);
  }, [deskItems, autoExpandDone, sortOrder]);

  const updateGroupBy = (next: AttentionGroupBy) => {
    setGroupBy(next);
    saveAttentionGroupBy(next);
  };
  const updateSortOrder = (next: AttentionSortOrder) => {
    setSortOrder(next);
    saveAttentionSortOrder(next);
  };
  const updateFilters = (next: AttentionFilterState) => {
    setFilters(next);
    saveAttentionFilters(selectedCompanyId, next);
  };
  const toggleGroupCollapse = (key: string) => {
    setCollapsedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsedAttentionGroupKeys(selectedCompanyId, next);
      return next;
    });
  };

  // All row callbacks are stable (deps are setState functions, stable hook
  // callbacks, and the stable mutation `mutate`s) so the memoized rows only re-render
  // when their own item/expanded/selected props change (PAP-13784).
  const handleDismiss = useCallback(
    (item: AttentionItem) => {
      setPendingHide((prev) => new Set(prev).add(item.id));
      // "Archive for me": personal, with an Undo toast from the close hook.
      closeCard({ item, mode: "archive" });
      setExpandedId((previous) => (previous === item.id ? null : previous));
    },
    [closeCard],
  );
  const handleSnooze = useCallback(
    (item: AttentionItem, snoozedUntil: string) => {
      // In the Archived view a new snooze time keeps the card; it only moves
      // to (or within) the Snoozed group after the refetch.
      if (!archivedView) {
        setPendingHide((prev) => new Set(prev).add(item.id));
        setExpandedId((previous) => (previous === item.id ? null : previous));
      }
      closeCard({ item, mode: "snooze", until: snoozedUntil });
    },
    [archivedView, closeCard],
  );
  const handleWithdraw = useCallback(
    (item: AttentionItem, reason: string) => {
      setPendingHide((prev) => new Set(prev).add(item.id));
      closeCard({ item, mode: "withdraw", reason });
      setExpandedId((previous) => (previous === item.id ? null : previous));
    },
    [closeCard],
  );
  const handleTransfer = useCallback(
    (item: AttentionItem, userId: string) => transferCard({ item, userId }),
    [transferCard],
  );
  const handleWithdrawAll = useCallback(
    (items: AttentionItem[], reason: string) => {
      setPendingHide((prev) => {
        const next = new Set(prev);
        for (const item of items) next.add(item.id);
        return next;
      });
      return closeActions.withdrawAll(items, reason).then((result) => {
        for (const item of result.failed) unhide(item);
        return result;
      });
    },
    [closeActions.withdrawAll, unhide],
  );
  // Restore deletes your dismissal: the card leaves Archived at once and is
  // back in its view after the refetch. It comes back here if the server refuses.
  const restoreCard = closeActions.restore;
  const handleRestore = useCallback(
    (item: AttentionItem) => {
      setPendingHide((prev) => new Set(prev).add(item.id));
      void restoreCard(item).then((restored) => {
        if (!restored) unhide(item);
      });
    },
    [restoreCard, unhide],
  );
  const handleToggleExpand = useCallback((item: AttentionItem) => {
    setSelectedAttentionId(item.id);
    setSelectionFromKeyboard(false);
    setExpandedId((prev) => (prev === item.id ? null : item.id));
  }, []);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const action = resolveAttentionQueueKeyAction({
        defaultPrevented: event.defaultPrevented,
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        target: event.target,
        hasOpenDialog: hasBlockingShortcutDialog(document),
        hasSelection: selectedAttentionId !== null,
      });
      if (action === "ignore" || keyboardItems.length === 0) return;

      if (action === "next" || action === "previous") {
        event.preventDefault();
        const currentIndex = selectedAttentionId ? keyboardItems.findIndex((item) => item.id === selectedAttentionId) : -1;
        const offset = action === "next" ? 1 : -1;
        const nextIndex = currentIndex < 0
          ? action === "next"
            ? 0
            : keyboardItems.length - 1
          : (currentIndex + offset + keyboardItems.length) % keyboardItems.length;
        setSelectedAttentionId(keyboardItems[nextIndex]?.id ?? null);
        setSelectionFromKeyboard(true);
        return;
      }

      const selectedItem = keyboardItems.find((item) => item.id === selectedAttentionId);
      if (!selectedItem) return;
      event.preventDefault();

      if (action === "dismiss") {
        handleDismiss(selectedItem);
      } else if (isInlineResolvable(selectedItem)) {
        setExpandedId((previous) => (previous === selectedItem.id ? null : selectedItem.id));
      } else if (selectedItem.subject.href) {
        navigate(selectedItem.subject.href);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleDismiss, keyboardItems, navigate, selectedAttentionId]);

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select an organization first.</p>;
  }

  // Keep a loaded feed on screen through a failed refetch; only a real
  // failure, or an outage before the first load, replaces the page.
  if (isLoading || feedView.kind === "reconnecting") {
    return <PageSkeleton variant="approvals" />;
  }
  if (feedView.kind === "error") {
    return (
      <QueryErrorState
        size="page"
        error={feedView.error}
        action="load your decisions"
        onRetry={feedView.retry}
        retrying={feedView.isFetching}
      />
    );
  }

  const receipts = view === "mine" ? feed?.receipts ?? [] : [];
  const hasAnything = activeItems.length > 0 || receipts.length > 0;

  return (
    <div ref={rootRef} className="max-w-3xl space-y-4">
      {/* Closed cards — answered, withdrawn, expired, closed with their task,
          approvals too — with outcome filters (PAP-749 plan §3). */}
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-md" data-classic-decision-history>
          <SheetHeader>
            <SheetTitle>Decision history</SheetTitle>
          </SheetHeader>
          <div className="p-4">
            {historyOpen && <DecisionHistoryPanel companyId={selectedCompanyId} agents={agents ?? []} userLabelMap={userLabelMap} />}
          </div>
        </SheetContent>
      </Sheet>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-bold">Decisions</h1>
          <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
            <History className="h-4 w-4" />
            Decision history
          </Button>
        </div>
        <AttentionViewSwitch value={view} counts={viewCounts} onChange={setView} everyone={everyone} />
        {view === "mine" ? <AttentionUnassignedBanner count={viewCounts.unassigned} onOpen={() => setView("unassigned")} /> : null}
        <DecisionsToolbar
          query={searchQuery}
          onQueryChange={setSearchQuery}
          visibleCount={visibleCount}
          filterOptions={filterOptions}
          filters={filters}
          onFiltersChange={updateFilters}
          groupBy={groupBy}
          onGroupByChange={updateGroupBy}
          sortOrder={sortOrder}
          onSortOrderChange={updateSortOrder}
        />
      </div>

      <AttentionReceiptList receipts={receipts} userLabelMap={userLabelMap}
        onDismiss={receiptActions.dismiss} dismissingId={receiptActions.dismissingId} onOpen={navigate} />

      {/* Queue quicklinks + date-range chips (§4.1–§4.2). The rail self-hides
          when the company has no queues; the chips filter the desk server-side. */}
      <div className="space-y-2">
        <DecisionQueueRail companyId={selectedCompanyId} activeQueueKey={null} />
        <DecisionDateChips
          value={dateRange}
          custom={customRange}
          onChange={(value, custom) => {
            setDateRange(value);
            setCustomRange(custom);
          }}
        />
      </div>

      {!hasAnything ? (
        <ZeroState view={view} />
      ) : (
        <div className="space-y-4">
          {visibleCount === 0 ? (
            <CaughtUpNote filtered={deskItems.length > 0} view={view} snoozedBelow={snoozedItems.length > 0} />
          ) : (
            <>
              {groups.map((group) => {
              const groupLabel = group.label;
              const collapsed = groupLabel !== null && collapsedGroupKeys.has(group.key);
              return (
                <section key={group.key} className="space-y-2">
                  {groupLabel !== null && (
                    <IssueGroupHeader
                      label={groupLabel}
                      collapsible
                      collapsed={collapsed}
                      onToggle={() => toggleGroupCollapse(group.key)}
                      trailing={
                        <span className="text-xs tabular-nums text-muted-foreground">{group.items.length}</span>
                      }
                    />
                  )}
                  {!collapsed && (
                    <div className="space-y-4">
                      {(() => {
                        const rows = renderPlan.groupRows.get(group.key) ?? [];
                        const seenBundles = new Set<string>();
                        return rows.map((item) => {
                          const bundleId =
                            item.sourceKind === "decision"
                              ? ((item.subject.metadata?.bundleId as string | null | undefined) ?? null)
                              : null;
                          let header: ReactNode = null;
                          if (bundleId && !seenBundles.has(bundleId)) {
                            seenBundles.add(bundleId);
                            const bundleRows = rows.filter(
                              (row) =>
                                row.sourceKind === "decision" &&
                                ((row.subject.metadata?.bundleId as string | null | undefined) ?? null) === bundleId,
                            );
                            const first = bundleRows[0];
                            header = (
                              <DecisionBundleHeader
                                agentName={agentMap.get(first?.subject.metadata?.originAgentId as string)?.name ?? null}
                                title={(first?.subject.metadata?.bundleTitle as string | null | undefined) ?? null}
                                originIssue={first?.relatedIssue ?? null}
                                count={bundleRows.length}
                              />
                            );
                          }
                          return (
                            <Fragment key={item.id}>
                              {header}
                              <div className={bundleId ? "border-l-2 border-violet-500/40 pl-3" : undefined}>
                                <AttentionQueueRow
                                  item={item}
                                  companyId={selectedCompanyId}
                                  expanded={expandedId === item.id}
                                  onToggleExpand={handleToggleExpand}
                                  onDismiss={handleDismiss}
                                  onSnooze={handleSnooze}
                                  onWithdraw={handleWithdraw}
                                  onTransfer={handleTransfer}
                                  onRestore={archivedView ? handleRestore : undefined}
                                  closing={closingId === item.id}
                                  agentMap={agentMap}
                                  agents={agents}
                                  showTriage
                                  currentUserId={currentUserId}
                                  userLabelMap={userLabelMap}
                                  onClaim={handleClaim}
                                  claiming={claimingId === item.id}
                                  selected={selectionFromKeyboard && selectedAttentionId === item.id}
                                  evidence={attentionObligationEvidence(obligations, item)}
                                />
                              </div>
                            </Fragment>
                          );
                        });
                      })()}
                    </div>
                  )}
                </section>
              );
              })}
            </>
          )}

          <AttentionStaleGroup
            items={visibleStaleItems}
            open={staleOpen}
            onToggle={() => setStaleOpen((prev) => !prev)}
            onWithdrawAll={handleWithdrawAll}
            busy={closeActions.bulkPending}
            currentUserId={currentUserId}
            userLabelMap={userLabelMap}
          >
            {visibleStaleItems.map((item) => (
              <AttentionQueueRow
                key={item.id}
                item={item}
                companyId={selectedCompanyId}
                expanded={expandedId === item.id}
                onToggleExpand={handleToggleExpand}
                onDismiss={handleDismiss}
                onSnooze={handleSnooze}
                onWithdraw={handleWithdraw}
                onTransfer={handleTransfer}
                closing={closingId === item.id}
                agentMap={agentMap}
                agents={agents}
                currentUserId={currentUserId}
                userLabelMap={userLabelMap}
                onClaim={handleClaim}
                claiming={claimingId === item.id}
                evidence={attentionObligationEvidence(obligations, item)}
              />
            ))}
          </AttentionStaleGroup>

          {/* Snoozed by you, in the Archived view: each card says when it
              comes back; Restore now or change the time (PAP-749 plan §3). */}
          <AttentionSnoozedGroup
            count={snoozedItems.length}
            open={snoozedOpen}
            onToggle={() => setSnoozedOpen((prev) => !prev)}
          >
            {renderPlan.snoozedRows.map((item) => (
              <AttentionQueueRow
                key={item.id}
                item={item}
                companyId={selectedCompanyId}
                expanded={expandedId === item.id}
                onToggleExpand={handleToggleExpand}
                onDismiss={handleDismiss}
                onSnooze={handleSnooze}
                onWithdraw={handleWithdraw}
                onTransfer={handleTransfer}
                onRestore={handleRestore}
                closing={closingId === item.id}
                agentMap={agentMap}
                agents={agents}
                currentUserId={currentUserId}
                userLabelMap={userLabelMap}
                onClaim={handleClaim}
                claiming={claimingId === item.id}
                evidence={attentionObligationEvidence(obligations, item)}
              />
            ))}
          </AttentionSnoozedGroup>

          {agingItems.length > 0 && (
            <Curtain
              label="Aging"
              count={agingItems.length}
              open={agingOpen}
              onToggle={() => setAgingOpen((prev) => !prev)}
            >
              <p className="text-xs text-muted-foreground">
                Idle past {ATTENTION_AGING_DAYS} days — kept off the desk. Keep any you still want surfaced.
              </p>
              {agingItems.map((item) => (
                <AgingItemRow
                  key={item.id}
                  item={item}
                  companyId={selectedCompanyId}
                  now={now}
                  agentMap={agentMap}
                  agents={agents}
                  currentUserId={currentUserId}
                  expanded={expandedId === item.id}
                  onToggleExpand={handleToggleExpand}
                  onDismiss={handleDismiss}
                  onSnooze={handleSnooze}
                  evidence={attentionObligationEvidence(obligations, item)}
                />
              ))}
            </Curtain>
          )}

        </div>
      )}

      <div className="space-y-4">
        <Curtain
          label="Decided"
          count={decisionHistoryCount(decidedDecisions?.length)}
          open={decidedOpen}
          onToggle={() => setDecidedOpen((prev) => !prev)}
        >
          {decidedDecisionsLoading ? (
            <p className="text-xs text-muted-foreground">Loading decided decisions…</p>
          ) : (decidedDecisions?.length ?? 0) > 0 ? (
            decidedDecisions!.slice(0, DECISION_HISTORY_VISIBLE_LIMIT).map((decision) => (
              <DecisionResolver
                key={decision.id}
                companyId={selectedCompanyId}
                decisionId={decision.id}
                agentMap={agentMap}
                initialDecision={{ ...decision, executions: decision.executions ?? [] }}
              />
            ))
          ) : (
            <p className="text-xs text-muted-foreground">No decided decisions.</p>
          )}
        </Curtain>

        <Curtain
          label="Expired"
          count={decisionHistoryCount(expiredDecisions?.length)}
          open={expiredOpen}
          onToggle={() => setExpiredOpen((prev) => !prev)}
        >
          {expiredDecisionsLoading ? (
            <p className="text-xs text-muted-foreground">Loading expired decisions…</p>
          ) : (expiredDecisions?.length ?? 0) > 0 ? (
            expiredDecisions!.slice(0, DECISION_HISTORY_VISIBLE_LIMIT).map((decision) => (
              <DecisionResolver
                key={decision.id}
                companyId={selectedCompanyId}
                decisionId={decision.id}
                agentMap={agentMap}
                initialDecision={{ ...decision, executions: decision.executions ?? [] }}
              />
            ))
          ) : (
            <p className="text-xs text-muted-foreground">No expired decisions.</p>
          )}
        </Curtain>
      </div>
    </div>
  );
}

/**
 * Violet left-rule strip over a run of decisions that share a bundle, e.g.
 * "Planner proposed 6 decisions · from PAP-123 · routing review · 6 pending".
 * Grouping is a surface only — each decision is still decided independently.
 */
export function DecisionBundleHeader({
  agentName,
  title,
  originIssue,
  count,
}: {
  agentName: string | null;
  title: string | null;
  originIssue: AttentionSubject | null;
  count: number;
}) {
  const noun = count === 1 ? "decision" : "decisions";
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-sm border-l-2 border-violet-500/60 bg-violet-500/5 px-3 py-1.5 text-xs">
      <span className="font-semibold text-violet-800 dark:text-violet-200">
        {agentName ?? "An agent"} proposed {count} {noun}
      </span>
      {originIssue && (originIssue.identifier || originIssue.title) && (
        <span className="text-muted-foreground">
          {"· from "}
          {originIssue.href ? (
            <a href={originIssue.href} className="hover:underline">
              {originIssue.identifier ?? originIssue.title}
            </a>
          ) : (
            originIssue.identifier ?? originIssue.title
          )}
        </span>
      )}
      {title && <span className="text-muted-foreground">· {title}</span>}
      <span className="text-muted-foreground">· {count} pending</span>
    </div>
  );
}

const CAUGHT_UP_TEXT: Record<AttentionPersonalView, string> = {
  mine: "You're all caught up.",
  unassigned: "No cards need an owner.",
  company: "No company alerts right now.",
  archived: "Nothing archived.",
  all: "No open cards for anyone.",
};

function CaughtUpNote({ filtered, view, snoozedBelow = false }: { filtered: boolean; view: AttentionPersonalView; snoozedBelow?: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-border py-10 text-center">
      <p className="text-sm font-medium text-foreground">
        {filtered
          ? "No decisions match your search or filters."
          : snoozedBelow ? "No archived cards. Snoozed cards are below." : CAUGHT_UP_TEXT[view]}
      </p>
      {filtered && (
        <p className="mt-1 text-xs text-muted-foreground">Adjust or clear your search and filters to see the rest.</p>
      )}
    </div>
  );
}

const ZERO_STATE_DETAIL: Record<AttentionPersonalView, string> = {
  mine: "Nothing needs a decision from you right now.",
  unassigned: "Every open card has an owner.",
  company: "No failed runs, agent errors, budget stops or join requests.",
  archived: "Cards you archive or snooze for yourself show here. Restore one to see it again.",
  all: "Nobody has a card waiting right now.",
};

function ZeroState({ view }: { view: AttentionPersonalView }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-20 text-center">
      <div className="mb-4 rounded-full bg-green-500/10 p-4">
        <CheckCircle2 className="h-10 w-10 text-green-500" />
      </div>
      <p className="text-lg font-semibold text-foreground">{view === "mine" ? "You're all caught up" : CAUGHT_UP_TEXT[view]}</p>
      <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
        <Inbox className="h-4 w-4" />
        {ZERO_STATE_DETAIL[view]}
      </p>
    </div>
  );
}
