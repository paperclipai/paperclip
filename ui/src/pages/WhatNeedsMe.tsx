import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpDown, Check, CheckCircle2, GraduationCap, Inbox, Layers, ListFilter, Loader2, Sun } from "lucide-react";
import type { Agent, AttentionItem, AttentionSubject } from "@paperclipai/shared";
import { useNavigate, useSearchParams } from "@/lib/router";
import { attentionApi } from "../api/attention";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { decisionsApi } from "../api/decisions";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { useInboxDismissals } from "../hooks/useInboxBadge";
import { queryKeys } from "../lib/queryKeys";
import {
  ATTENTION_AGING_DAYS,
  ATTENTION_GROUP_BY_OPTIONS,
  ATTENTION_SORT_OPTIONS,
  attentionDecideOrder,
  attentionIdleDays,
  attentionIsAging,
  buildAttentionFilterOptions,
  countActiveAttentionFilters,
  defaultAttentionFilterState,
  filterAttentionItems,
  groupAttentionItems,
  isInlineResolvable,
  loadAttentionFilters,
  loadAttentionGroupBy,
  loadAttentionSortOrder,
  loadCollapsedAttentionGroupKeys,
  NO_GROUP_SENTINEL,
  partitionDecideNow,
  planAttentionRenderRows,
  resolveAttentionDateRange,
  saveAttentionFilters,
  saveAttentionGroupBy,
  saveAttentionSortOrder,
  saveCollapsedAttentionGroupKeys,
  sortAttentionItems,
  sourceMeta,
  type AttentionDateRangeId,
  type AttentionFilterState,
  type AttentionGroup,
  type AttentionGroupBy,
  type AttentionSortOrder,
} from "../lib/attention";
import { decisionQueuesApi } from "../api/decisionQueues";
import { decisionTrainingHref } from "../lib/decisionTraining";
import { cn } from "../lib/utils";
import { hasBlockingShortcutDialog, resolveAttentionQueueKeyAction } from "../lib/keyboardShortcuts";
import { PageSkeleton } from "../components/PageSkeleton";
import { AttentionQueueRow } from "../components/AttentionQueueRow";
import { DecisionQueueRail } from "../components/DecisionQueueRail";
import { DecisionDateChips, type AttentionCustomRange } from "../components/DecisionDateChips";
import { DecisionResolver } from "../components/DecisionResolver";
import { DecisionTrainingDrawer } from "../components/DecisionTrainingDrawer";
import { IssueGroupHeader } from "../components/IssueGroupHeader";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";

const SEVERITY_LABELS: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Curtain rows never expand; module-level so memoized rows see one identity. */
const noopToggleExpand = () => {};

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
  const { selectedCompanyId } = useCompany();
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
  // Decision-training drawer target. `null` when closed.
  const [trainingItem, setTrainingItem] = useState<AttentionItem | null>(null);

  // Toolbar preferences (persisted to localStorage, Inbox pattern).
  const [groupBy, setGroupBy] = useState<AttentionGroupBy>(() => loadAttentionGroupBy());
  const [sortOrder, setSortOrder] = useState<AttentionSortOrder>(() => loadAttentionSortOrder());
  const [filters, setFilters] = useState<AttentionFilterState>(() => defaultAttentionFilterState);
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(() => new Set());
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [dismissedOpen, setDismissedOpen] = useState(false);
  const [agingOpen, setAgingOpen] = useState(false);
  const [decidedOpen, setDecidedOpen] = useState(false);
  const [expiredOpen, setExpiredOpen] = useState(false);

  // Date-range chips (PAP-16032 §4.2) — resolve to server-side activity bounds.
  const [dateRange, setDateRange] = useState<AttentionDateRangeId>("all");
  const [customRange, setCustomRange] = useState<AttentionCustomRange>({ from: null, to: null });

  // `?decisionId=` deep link (PAP-16032 §4.7) — focus/expand the referenced card.
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkDecisionId = searchParams.get("decisionId");
  const [deepLinkConsumed, setDeepLinkConsumed] = useState(false);

  // Optimistic hide/restore. Reset whenever a fresh feed lands (server truth).
  const [pendingHide, setPendingHide] = useState<Set<string>>(() => new Set());
  const [pendingRestore, setPendingRestore] = useState<Set<string>>(() => new Set());

  const { dismiss, snooze, restore } = useInboxDismissals(selectedCompanyId);
  const { pushToast } = useToastActions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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

  const {
    data: feed,
    isLoading,
    error,
  } = useQuery({
    // Distinct from the sidebar badge's `queryKeys.attention` so dismissed rows
    // (needed for the curtains) never inflate the badge count. Invalidating the
    // `["attention", companyId]` prefix still cascades to this query.
    queryKey: [
      ...queryKeys.attention(selectedCompanyId!),
      "with-dismissed",
      activityBounds.activitySince ?? null,
      activityBounds.activityUntil ?? null,
    ],
    queryFn: () => attentionApi.list(selectedCompanyId!, { includeDismissed: true, ...activityBounds }),
    enabled: !!selectedCompanyId,
    refetchOnWindowFocus: true,
  });

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

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents ?? []) map.set(agent.id, agent);
    return map;
  }, [agents]);

  // Reset optimistic state once the server sends a fresh snapshot.
  useEffect(() => {
    setPendingHide(new Set());
    setPendingRestore(new Set());
  }, [feed?.generatedAt]);

  const allItems = useMemo(() => feed?.items ?? [], [feed]);

  const isServerHidden = (item: AttentionItem) => item.dismissal != null && item.dismissal.isActive;

  const activeItems = useMemo(
    () =>
      allItems.filter(
        (item) => (!isServerHidden(item) || pendingRestore.has(item.id)) && !pendingHide.has(item.id),
      ),
    [allItems, pendingHide, pendingRestore],
  );

  // The server's clock at feed time — used for the decide-by split and the aging
  // idle labels so they match `decideNowCount` and the sidebar badge exactly,
  // and stay stable across renders (Date.now() only as a pre-load fallback).
  const now = useMemo(
    () => (feed?.generatedAt ? new Date(feed.generatedAt).getTime() : Date.now()),
    [feed?.generatedAt],
  );

  // Aging shelf (§4.4): items the server flags as idle past retention leave the
  // live desk for their own curtain, so today's desk shows only fresh decisions.
  const agingItems = useMemo(() => activeItems.filter(attentionIsAging), [activeItems]);
  const deskItems = useMemo(() => activeItems.filter((item) => !attentionIsAging(item)), [activeItems]);
  const snoozedItems = useMemo(
    () =>
      allItems.filter(
        (item) =>
          item.dismissal?.kind === "snooze" && item.dismissal.isActive && !pendingRestore.has(item.id),
      ),
    [allItems, pendingRestore],
  );
  const dismissedItems = useMemo(
    () =>
      allItems.filter(
        (item) =>
          item.dismissal?.kind === "dismiss" && item.dismissal.isActive && !pendingRestore.has(item.id),
      ),
    [allItems, pendingRestore],
  );

  const filterOptions = useMemo(() => buildAttentionFilterOptions(deskItems), [deskItems]);

  // Filter → sort → group, all client-side so switching re-buckets without a
  // refetch. In the default (ungrouped) view the desk splits into the two §4.3
  // shelves — "Decide now" (due today / overdue) and "Can wait" — ordered by
  // decide-by; any explicit group-by keeps the Inbox-style activity grouping.
  const groups = useMemo<AttentionGroup[]>(() => {
    const filtered = filterAttentionItems(deskItems, filters);
    if (groupBy === "none") {
      const ordered = [...filtered].sort((a, b) => {
        const [aBucket, aDeadline] = attentionDecideOrder(a, now);
        const [bBucket, bDeadline] = attentionDecideOrder(b, now);
        if (aBucket !== bBucket) return aBucket - bBucket;
        if (aDeadline !== bDeadline) return aDeadline - bDeadline;
        return a.rank - b.rank;
      });
      const { decideNow, canWait } = partitionDecideNow(ordered, now);
      const shelves: AttentionGroup[] = [];
      if (decideNow.length > 0) shelves.push({ key: "desk:decide-now", label: "Decide now", items: decideNow });
      if (canWait.length > 0) shelves.push({ key: "desk:can-wait", label: "Can wait", items: canWait });
      return shelves;
    }
    const sorted = sortAttentionItems(filtered, sortOrder);
    return groupAttentionItems(sorted, groupBy);
  }, [deskItems, filters, sortOrder, groupBy, now]);

  // "Today is clear" — the desk has decisions but none are due today.
  const deskClearToday = useMemo(
    () => groupBy === "none" && deskItems.length > 0 && !groups.some((group) => group.key === "desk:decide-now"),
    [groupBy, deskItems, groups],
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
      dismissedItems,
      dismissedOpen,
      limit: Math.max(renderedRowLimit, selectedIndex + 1),
    });
  }, [
    collapsedGroupKeys,
    dismissedItems,
    dismissedOpen,
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
    if (deepLinkConsumed || !deepLinkDecisionId || allItems.length === 0) return;
    const target = allItems.find(
      (item) => item.sourceKind === "decision" && item.subject.id === deepLinkDecisionId,
    );
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
  }, [allItems, deepLinkConsumed, deepLinkDecisionId, setSearchParams]);

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
  // callbacks, and the stable `pushToast`) so the memoized rows only re-render
  // when their own item/expanded/selected props change (PAP-13784).
  const handleUndoDismiss = useCallback(
    (item: AttentionItem) => {
      setPendingHide((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
      restore(item.dismissalKey);
    },
    [restore],
  );
  const handleDismiss = useCallback(
    (item: AttentionItem) => {
      setPendingHide((prev) => new Set(prev).add(item.id));
      dismiss(item.dismissalKey);
      setExpandedId((previous) => (previous === item.id ? null : previous));
      // ~8s undo window; restores the row in place via T1's DELETE endpoint.
      pushToast({
        id: `attention-dismiss-${item.id}`,
        dedupeKey: `attention-dismiss-${item.dismissalKey}`,
        title: "Dismissed",
        body: item.subject.title ?? undefined,
        tone: "info",
        ttlMs: 8000,
        action: { label: "Undo", onClick: () => handleUndoDismiss(item) },
      });
    },
    [dismiss, handleUndoDismiss, pushToast],
  );
  const handleSnooze = useCallback(
    (item: AttentionItem, snoozedUntil: string) => {
      setPendingHide((prev) => new Set(prev).add(item.id));
      snooze(item.dismissalKey, snoozedUntil);
      setExpandedId((previous) => (previous === item.id ? null : previous));
    },
    [snooze],
  );
  const handleRestore = useCallback(
    (item: AttentionItem) => {
      setPendingRestore((prev) => new Set(prev).add(item.id));
      restore(item.dismissalKey);
    },
    [restore],
  );
  const handleToggleExpand = useCallback((item: AttentionItem) => {
    setSelectedAttentionId(item.id);
    setSelectionFromKeyboard(false);
    setExpandedId((prev) => (prev === item.id ? null : item.id));
  }, []);
  const handleTrain = useCallback((item: AttentionItem) => {
    setTrainingItem(item);
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
  const activeFilterCount = countActiveAttentionFilters(filters);

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select a company first.</p>;
  }

  if (isLoading) {
    return <PageSkeleton variant="approvals" />;
  }

  const hasAnything = activeItems.length > 0 || snoozedItems.length > 0 || dismissedItems.length > 0;

  return (
    <div ref={rootRef} className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-bold">Decisions</h1>
        <div className="flex items-center gap-2">
          {visibleCount > 0 && (
            <span className="text-sm text-muted-foreground">
              {visibleCount} {visibleCount === 1 ? "decision" : "decisions"}
            </span>
          )}
          {/* Filter */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className={cn("h-8 w-8 shrink-0", activeFilterCount > 0 && "bg-accent")}
                title="Filter"
                aria-label="Filter"
              >
                <ListFilter className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 p-0">
              <FilterMenu
                options={filterOptions}
                filters={filters}
                onChange={updateFilters}
              />
            </PopoverContent>
          </Popover>
          {/* Group by */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className={cn("h-8 w-8 shrink-0", groupBy !== "none" && "bg-accent")}
                title="Group"
                aria-label="Group"
              >
                <Layers className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-40 p-2">
              <div className="space-y-0.5">
                {ATTENTION_GROUP_BY_OPTIONS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={cn(
                      "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm",
                      groupBy === value ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/50",
                    )}
                    onClick={() => updateGroupBy(value)}
                  >
                    <span>{label}</span>
                    {groupBy === value ? <Check className="h-3.5 w-3.5" /> : null}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8 shrink-0"
            title="Training"
            aria-label="Training"
            onClick={() => navigate(decisionTrainingHref())}
          >
            <GraduationCap className="h-3.5 w-3.5" />
          </Button>
          {/* Sort */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                title="Sort"
                aria-label="Sort"
              >
                <ArrowUpDown className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-44 p-2">
              <div className="space-y-0.5">
                {ATTENTION_SORT_OPTIONS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={cn(
                      "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm",
                      sortOrder === value ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/50",
                    )}
                    onClick={() => updateSortOrder(value)}
                  >
                    <span>{label}</span>
                    {sortOrder === value ? <Check className="h-3.5 w-3.5" /> : null}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

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

      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {!hasAnything ? (
        <ZeroState />
      ) : (
        <div className="space-y-4">
          {visibleCount === 0 ? (
            <CaughtUpNote filtered={deskItems.length > 0} />
          ) : (
            <>
              {deskClearToday && <TodayClearNote />}
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
                                  onTrain={handleTrain}
                                  agentMap={agentMap}
                                  agents={agents}
                                  showTriage
                                  currentUserId={currentUserId}
                                  selected={selectionFromKeyboard && selectedAttentionId === item.id}
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

          {snoozedItems.length > 0 && (
            <Curtain
              label="Snoozed"
              count={snoozedItems.length}
              open={snoozedOpen}
              onToggle={() => setSnoozedOpen((prev) => !prev)}
            >
              {renderPlan.snoozedRows.map((item) => (
                <AttentionQueueRow
                  key={item.id}
                  item={item}
                  companyId={selectedCompanyId}
                  variant="hidden"
                  expanded={false}
                  onToggleExpand={noopToggleExpand}
                  onDismiss={handleDismiss}
                  onRestore={handleRestore}
                  agentMap={agentMap}
                  currentUserId={currentUserId}
                />
              ))}
            </Curtain>
          )}

          {dismissedItems.length > 0 && (
            <Curtain
              label="Dismissed"
              count={dismissedItems.length}
              open={dismissedOpen}
              onToggle={() => setDismissedOpen((prev) => !prev)}
            >
              {renderPlan.dismissedRows.map((item) => (
                <AttentionQueueRow
                  key={item.id}
                  item={item}
                  companyId={selectedCompanyId}
                  variant="hidden"
                  expanded={false}
                  onToggleExpand={noopToggleExpand}
                  onDismiss={handleDismiss}
                  onRestore={handleRestore}
                  agentMap={agentMap}
                  currentUserId={currentUserId}
                />
              ))}
            </Curtain>
          )}

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
                  onTrain={handleTrain}
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

      <DecisionTrainingDrawer
        open={trainingItem !== null}
        onOpenChange={(next) => {
          if (!next) setTrainingItem(null);
        }}
        companyId={selectedCompanyId}
        item={trainingItem}
        currentUserId={currentUserId}
      />
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

function FilterMenu({
  options,
  filters,
  onChange,
}: {
  options: ReturnType<typeof buildAttentionFilterOptions>;
  filters: AttentionFilterState;
  onChange: (next: AttentionFilterState) => void;
}) {
  const toggle = (key: keyof AttentionFilterState, value: string) => {
    const list = filters[key] as string[];
    const nextList = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
    onChange({ ...filters, [key]: nextList });
  };
  const hasActive = countActiveAttentionFilters(filters) > 0;

  return (
    <div className="max-h-(--sz-70vh) overflow-y-auto">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Filter</span>
        {hasActive && (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => onChange(defaultAttentionFilterState)}
          >
            Clear
          </button>
        )}
      </div>

      {options.sourceKinds.length > 1 && (
        <FilterSection title="Type">
          {options.sourceKinds.map((kind) => (
            <FilterRow
              key={kind}
              label={sourceMeta(kind).label}
              checked={filters.sourceKinds.includes(kind)}
              onToggle={() => toggle("sourceKinds", kind)}
            />
          ))}
        </FilterSection>
      )}

      {options.severities.length > 1 && (
        <FilterSection title="Severity">
          {options.severities.map((severity) => (
            <FilterRow
              key={severity}
              label={SEVERITY_LABELS[severity] ?? severity}
              checked={filters.severities.includes(severity)}
              onToggle={() => toggle("severities", severity)}
            />
          ))}
        </FilterSection>
      )}

      {(options.projects.length > 0 || options.hasNoProject) && (
        <FilterSection title="Project">
          {options.projects.map((project) => (
            <FilterRow
              key={project.id}
              label={project.name}
              checked={filters.projectIds.includes(project.id)}
              onToggle={() => toggle("projectIds", project.id)}
            />
          ))}
          {options.hasNoProject && (
            <FilterRow
              label="No project"
              checked={filters.projectIds.includes(NO_GROUP_SENTINEL)}
              onToggle={() => toggle("projectIds", NO_GROUP_SENTINEL)}
            />
          )}
        </FilterSection>
      )}

      {(options.workspaces.length > 0 || options.hasNoWorkspace) && (
        <FilterSection title="Workspace">
          {options.workspaces.map((workspace) => (
            <FilterRow
              key={workspace.id}
              label={workspace.name}
              checked={filters.workspaceIds.includes(workspace.id)}
              onToggle={() => toggle("workspaceIds", workspace.id)}
            />
          ))}
          {options.hasNoWorkspace && (
            <FilterRow
              label="No workspace"
              checked={filters.workspaceIds.includes(NO_GROUP_SENTINEL)}
              onToggle={() => toggle("workspaceIds", NO_GROUP_SENTINEL)}
            />
          )}
        </FilterSection>
      )}
    </div>
  );
}

function FilterSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-border/60 px-2 py-1.5">
      <p className="px-1 pb-1 text-(length:--text-nano) font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function FilterRow({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-sm px-1 py-1 text-left text-sm hover:bg-accent/50"
      onClick={onToggle}
    >
      <Checkbox checked={checked} className="pointer-events-none" tabIndex={-1} />
      <span className="truncate">{label}</span>
    </button>
  );
}

function Curtain({
  label,
  count,
  open,
  onToggle,
  children,
}: {
  label: string;
  count?: number | string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <IssueGroupHeader
        label={count == null ? label : `${label} (${count})`}
        collapsible
        collapsed={!open}
        onToggle={onToggle}
        className="text-muted-foreground"
      />
      {open && <div className="space-y-4">{children}</div>}
    </section>
  );
}

/**
 * Slim banner shown at the top of the desk when there are decisions but none
 * are due today — the "Decide now" shelf is empty, so we say so rather than
 * leading with a bare "Can wait" header (§4.3 "empty state when today is clear").
 */
function TodayClearNote() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 px-4 py-3">
      <Sun className="h-4 w-4 shrink-0 text-green-500" />
      <p className="text-sm text-foreground">
        Nothing needs a decision <span className="font-medium">today</span>. Everything below can wait.
      </p>
    </div>
  );
}

/**
 * An aging-shelf row (§4.4): the standard card, prefaced by an idle-duration
 * label and a "Keep on desk" affordance that clears the shelf flag server-side
 * (P1 retention `keep`). Archival/sweeper mechanics are P5 — this is the split
 * plus the Keep stub only.
 */
function AgingItemRow({
  item,
  companyId,
  now,
  agentMap,
  agents,
  currentUserId,
  expanded,
  onToggleExpand,
  onDismiss,
  onSnooze,
  onTrain,
}: {
  item: AttentionItem;
  companyId: string;
  now: number;
  agentMap: Map<string, Agent>;
  agents: Agent[] | undefined;
  currentUserId: string | null;
  expanded: boolean;
  onToggleExpand: (item: AttentionItem) => void;
  onDismiss: (item: AttentionItem) => void;
  onSnooze: (item: AttentionItem, snoozedUntil: string) => void;
  onTrain: (item: AttentionItem) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const idleDays = attentionIdleDays(item, now);
  const keep = useMutation({
    mutationFn: () => decisionQueuesApi.setKeep(companyId, item.sourceKind, item.subject.id, true),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
      pushToast({ title: "Kept on desk", body: item.subject.title ?? undefined, tone: "success" });
    },
    onError: (error) =>
      pushToast({
        title: "Could not keep this decision",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      }),
  });

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-(length:--text-nano) text-muted-foreground">
          Idle {idleDays} {idleDays === 1 ? "day" : "days"}
        </span>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="h-7 gap-1"
          disabled={keep.isPending || item.keep}
          onClick={() => keep.mutate()}
        >
          {keep.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
          <Sun className="h-3.5 w-3.5" />
          {item.keep ? "Kept" : "Keep on desk"}
        </Button>
      </div>
      <AttentionQueueRow
        item={item}
        companyId={companyId}
        expanded={expanded}
        onToggleExpand={onToggleExpand}
        onDismiss={onDismiss}
        onSnooze={onSnooze}
        onTrain={onTrain}
        agentMap={agentMap}
        agents={agents}
        showTriage
        currentUserId={currentUserId}
      />
    </div>
  );
}

function CaughtUpNote({ filtered }: { filtered: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-border py-10 text-center">
      <p className="text-sm font-medium text-foreground">
        {filtered ? "No decisions match your filters." : "You're all caught up."}
      </p>
      {filtered && (
        <p className="mt-1 text-xs text-muted-foreground">Adjust or clear the filters to see the rest.</p>
      )}
    </div>
  );
}

function ZeroState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-20 text-center">
      <div className="mb-4 rounded-full bg-green-500/10 p-4">
        <CheckCircle2 className="h-10 w-10 text-green-500" />
      </div>
      <p className="text-lg font-semibold text-foreground">You're all caught up</p>
      <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
        <Inbox className="h-4 w-4" />
        Nothing needs a decision from you right now.
      </p>
    </div>
  );
}
