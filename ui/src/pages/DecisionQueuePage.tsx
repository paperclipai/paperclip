import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Settings2, X } from "lucide-react";
import type { Agent, AttentionItem } from "@paperclipai/shared";
import { useNavigate, useParams } from "@/lib/router";
import { attentionApi } from "../api/attention";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { decisionQueuesApi } from "../api/decisionQueues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { useInboxDismissals } from "../hooks/useInboxBadge";
import { queryKeys } from "../lib/queryKeys";
import {
  ATTENTION_AGING_DAYS,
  attentionIsAging,
  buildAttentionFilterOptions,
  buildDeskShelves,
  defaultAttentionFilterState,
  filterAttentionItems,
  groupAttentionItems,
  loadAttentionFilters,
  loadAttentionGroupBy,
  loadAttentionSortOrder,
  loadCollapsedAttentionGroupKeys,
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
import { decisionTrainingHref } from "../lib/decisionTraining";
import { cn } from "../lib/utils";
import { PageSkeleton } from "../components/PageSkeleton";
import { AttentionQueueRow } from "../components/AttentionQueueRow";
import { DecisionsToolbar } from "../components/DecisionsToolbar";
import { Curtain, AgingItemRow } from "../components/DecisionShelf";
import { DecisionQueueRail } from "../components/DecisionQueueRail";
import { DecisionDateChips, type AttentionCustomRange } from "../components/DecisionDateChips";
import { DecisionTrainingDrawer } from "../components/DecisionTrainingDrawer";
import { IssueGroupHeader } from "../components/IssueGroupHeader";
import { Button } from "../components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";

/**
 * Queue page. A single queue's pending
 * decisions with per-item resolution, exclusion (with an optional reason), and
 * the queue's seed-rules card with an enable/disable toggle.
 *
 * The queue exposes the same toolbar the desk does — filter,
 * group-by, sort, the arrival timeline groupings, the date-range chips, and the
 * aging shelf — sharing the desk's `DecisionsToolbar`, grouping helpers, and
 * shelf components so a decision looks, groups, and resolves the same wherever it
 * is surfaced.
 */
export function DecisionQueuePage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams<{ key: string }>();
  const queueKey = params.key ?? "";
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { dismiss, snooze } = useInboxDismissals(selectedCompanyId);

  // Decision-training drawer target. `null` when closed.
  const [trainingItem, setTrainingItem] = useState<AttentionItem | null>(null);

  // Toolbar preferences (persisted to localStorage, shared with the desk).
  const [groupBy, setGroupBy] = useState<AttentionGroupBy>(() => loadAttentionGroupBy());
  const [sortOrder, setSortOrder] = useState<AttentionSortOrder>(() => loadAttentionSortOrder());
  const [filters, setFilters] = useState<AttentionFilterState>(() => defaultAttentionFilterState);
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(() => new Set());
  const [agingOpen, setAgingOpen] = useState(false);

  // Date-range chips (§4.2) — resolve to server-side activity bounds.
  const [dateRange, setDateRange] = useState<AttentionDateRangeId>("all");
  const [customRange, setCustomRange] = useState<AttentionCustomRange>({ from: null, to: null });

  const activityBounds = useMemo(
    () => resolveAttentionDateRange(dateRange, Date.now(), customRange),
    [dateRange, customRange],
  );

  const { data: queues } = useQuery({
    queryKey: queryKeys.decisionQueues.list(selectedCompanyId!),
    queryFn: () => decisionQueuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const queue = useMemo(() => queues?.find((q) => q.key === queueKey) ?? null, [queues, queueKey]);

  const {
    data: feed,
    isLoading,
    error,
  } = useQuery({
    queryKey: [
      ...queryKeys.attention(selectedCompanyId!),
      "queue",
      queueKey,
      activityBounds.activitySince ?? null,
      activityBounds.activityUntil ?? null,
    ],
    queryFn: () => attentionApi.list(selectedCompanyId!, { queue: queueKey, all: true, ...activityBounds }),
    enabled: !!selectedCompanyId && !!queueKey,
    refetchOnWindowFocus: true,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
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

  useEffect(() => {
    setBreadcrumbs([{ label: "Decisions", href: "/decisions" }, { label: queue?.title ?? queueKey }]);
  }, [setBreadcrumbs, queue?.title, queueKey]);

  // Re-hydrate per-company preferences when the company changes.
  useEffect(() => {
    setFilters(loadAttentionFilters(selectedCompanyId));
    setCollapsedGroupKeys(loadCollapsedAttentionGroupKeys(selectedCompanyId));
  }, [selectedCompanyId]);

  // The server's clock at feed time — used for the arrival/decide-by shelves and
  // the aging idle labels so they match the desk exactly.
  const now = useMemo(
    () => (feed?.generatedAt ? new Date(feed.generatedAt).getTime() : Date.now()),
    [feed?.generatedAt],
  );

  const activeItems = useMemo(
    () => (feed?.items ?? []).filter((item) => !(item.dismissal?.isActive ?? false)),
    [feed],
  );

  // Aging shelf (§4.4): items the server flags as idle past retention leave the
  // live list for their own curtain, mirroring the desk.
  const agingItems = useMemo(() => activeItems.filter(attentionIsAging), [activeItems]);
  const listItems = useMemo(() => activeItems.filter((item) => !attentionIsAging(item)), [activeItems]);

  const filterOptions = useMemo(() => buildAttentionFilterOptions(listItems), [listItems]);

  // Filter → sort → group, matching the desk. In the default (ungrouped) view the
  // list groups by arrival ("New today" / "Earlier", plus a "Decide now" shelf
  // when something carries an explicit due decide-by); any explicit group-by keeps
  // the Inbox-style activity grouping.
  const groups = useMemo<AttentionGroup[]>(() => {
    const filtered = filterAttentionItems(listItems, filters);
    if (groupBy === "none") {
      return buildDeskShelves(filtered, now);
    }
    const sorted = sortAttentionItems(filtered, sortOrder);
    return groupAttentionItems(sorted, groupBy);
  }, [listItems, filters, sortOrder, groupBy, now]);

  const visibleCount = useMemo(() => groups.reduce((sum, group) => sum + group.items.length, 0), [groups]);

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

  const handleToggleExpand = useCallback((item: AttentionItem) => {
    setExpandedId((prev) => (prev === item.id ? null : item.id));
  }, []);
  const handleTrain = useCallback((item: AttentionItem) => {
    setTrainingItem(item);
  }, []);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.attention(selectedCompanyId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.decisionQueues.list(selectedCompanyId!) });
  };

  const toggleSeedRules = useMutation({
    mutationFn: (enabled: boolean) =>
      decisionQueuesApi.update(selectedCompanyId!, queueKey, { seedRulesEnabled: enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.decisionQueues.list(selectedCompanyId!) }),
    onError: (err) =>
      pushToast({
        title: "Could not update seeding",
        body: err instanceof Error ? err.message : "Please try again.",
        tone: "error",
      }),
  });

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select a company first.</p>;
  }
  if (isLoading) {
    return <PageSkeleton variant="approvals" />;
  }

  const isEmpty = activeItems.length === 0;

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-xl font-bold">{queue?.title ?? queueKey}</h1>
          {queue?.description && <p className="mt-0.5 text-sm text-muted-foreground">{queue.description}</p>}
        </div>
        <DecisionsToolbar
          visibleCount={visibleCount}
          filterOptions={filterOptions}
          filters={filters}
          onFiltersChange={updateFilters}
          groupBy={groupBy}
          onGroupByChange={updateGroupBy}
          sortOrder={sortOrder}
          onSortOrderChange={updateSortOrder}
          onOpenTraining={() => navigate(decisionTrainingHref())}
        />
      </div>

      <div className="space-y-2">
        <DecisionQueueRail companyId={selectedCompanyId} activeQueueKey={queueKey} />
        <DecisionDateChips
          value={dateRange}
          custom={customRange}
          onChange={(value, custom) => {
            setDateRange(value);
            setCustomRange(custom);
          }}
        />
      </div>

      {queue && queue.seedRules.length > 0 && (
        <SeedRulesCard
          enabled={queue.seedRulesEnabled}
          rules={queue.seedRules.map((rule) => rule.description)}
          pending={toggleSeedRules.isPending}
          onToggle={() => toggleSeedRules.mutate(!queue.seedRulesEnabled)}
        />
      )}

      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {isEmpty ? (
        <div className="rounded-xl border border-dashed border-border py-14 text-center">
          <p className="text-sm font-medium text-foreground">This queue is empty.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Decisions land here when they match the queue's rules or an agent adds them.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {visibleCount === 0 ? (
            <div className="rounded-xl border border-dashed border-border py-10 text-center">
              <p className="text-sm font-medium text-foreground">No decisions match your filters.</p>
              <p className="mt-1 text-xs text-muted-foreground">Adjust or clear the filters to see the rest.</p>
            </div>
          ) : (
            groups.map((group) => {
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
                      {group.items.map((item) => (
                        <QueueItemRow
                          key={item.id}
                          item={item}
                          companyId={selectedCompanyId}
                          queueKey={queueKey}
                          agentMap={agentMap}
                          agents={agents}
                          currentUserId={currentUserId}
                          expanded={expandedId === item.id}
                          onToggleExpand={handleToggleExpand}
                          onDismiss={(next) => dismiss(next.dismissalKey)}
                          onSnooze={(next, until) => snooze(next.dismissalKey, until)}
                          onTrain={handleTrain}
                          onExcluded={invalidate}
                        />
                      ))}
                    </div>
                  )}
                </section>
              );
            })
          )}

          {agingItems.length > 0 && (
            <Curtain
              label="Aging"
              count={agingItems.length}
              open={agingOpen}
              onToggle={() => setAgingOpen((prev) => !prev)}
            >
              <p className="text-xs text-muted-foreground">
                Idle past {ATTENTION_AGING_DAYS} days — kept off the queue. Keep any you still want surfaced.
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
                  onDismiss={(next) => dismiss(next.dismissalKey)}
                  onSnooze={(next, until) => snooze(next.dismissalKey, until)}
                  onTrain={handleTrain}
                />
              ))}
            </Curtain>
          )}
        </div>
      )}

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
 * Auto-seed card: explains in place what seeding does — the queue's seed rules
 * (from `DECISION_QUEUE_SEEDS`) that pull matching decisions in automatically —
 * and what the toggle changes. Disabling stops only the automatic adds; anything
 * already here stays, and manual adds keep working.
 */
function SeedRulesCard({
  enabled,
  rules,
  pending,
  onToggle,
}: {
  enabled: boolean;
  rules: string[];
  pending: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <Settings2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium text-foreground">Auto-seeding is {enabled ? "on" : "off"}</p>
            <p className="text-xs text-muted-foreground">
              {enabled
                ? "This queue fills itself automatically. Decisions are added the moment they match any of its rules:"
                : "Automatic adds are paused. These rules would add decisions to the queue when on:"}
            </p>
            <ul className="mt-0.5 space-y-0.5">
              {rules.map((rule) => (
                <li key={rule} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Check className="mt-0.5 h-3 w-3 shrink-0" />
                  {rule}
                </li>
              ))}
            </ul>
            <p className="text-(length:--text-nano) text-muted-foreground">
              {enabled
                ? "Turning it off stops new automatic adds only — decisions already here stay, and you can still add or remove decisions by hand."
                : "Adding or removing decisions by hand still works while automatic seeding is off."}
            </p>
          </div>
        </div>
        <Button type="button" variant="outline" size="xs" className="h-7 shrink-0" disabled={pending} onClick={onToggle}>
          {pending && <Loader2 className="h-3 w-3 animate-spin" />}
          {enabled ? "Disable" : "Enable"}
        </Button>
      </div>
    </div>
  );
}

function QueueItemRow({
  item,
  companyId,
  queueKey,
  agentMap,
  agents,
  currentUserId,
  expanded,
  onToggleExpand,
  onDismiss,
  onSnooze,
  onTrain,
  onExcluded,
}: {
  item: AttentionItem;
  companyId: string;
  queueKey: string;
  agentMap: Map<string, Agent>;
  agents: Agent[] | undefined;
  currentUserId: string | null;
  expanded: boolean;
  onToggleExpand: (item: AttentionItem) => void;
  onDismiss: (item: AttentionItem) => void;
  onSnooze: (item: AttentionItem, snoozedUntil: string) => void;
  onTrain: (item: AttentionItem) => void;
  onExcluded: () => void;
}) {
  const { pushToast } = useToastActions();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const exclude = useMutation({
    mutationFn: async () => {
      await decisionQueuesApi.removeItem(
        companyId,
        queueKey,
        item.sourceKind,
        item.subject.id,
        reason.trim() || undefined,
      );
    },
    onSuccess: () => {
      setOpen(false);
      setReason("");
      pushToast({ title: "Removed from queue", body: item.subject.title ?? undefined, tone: "info" });
      onExcluded();
    },
    onError: (err) =>
      pushToast({
        title: "Could not exclude",
        body: err instanceof Error ? err.message : "Please try again.",
        tone: "error",
      }),
  });

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-end px-1">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="xs" className="h-7 gap-1 text-muted-foreground">
              <X className="h-3.5 w-3.5" />
              Exclude
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 space-y-2 p-3">
            <p className="text-xs font-medium text-foreground">Remove from this queue</p>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Reason (optional)…"
              className="min-h-16 w-full rounded-sm border border-border bg-background px-2 py-1 text-xs"
            />
            <div className="flex justify-end gap-1">
              <Button type="button" variant="ghost" size="xs" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                size="xs"
                className={cn(exclude.isPending && "opacity-80")}
                disabled={exclude.isPending}
                onClick={() => exclude.mutate()}
              >
                {exclude.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                Exclude
              </Button>
            </div>
          </PopoverContent>
        </Popover>
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
