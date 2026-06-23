import { useMemo, useState } from "react";
import { Activity as ActivityIcon, Play, SlidersHorizontal } from "lucide-react";
import { t, useTranslation } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { timeAgo } from "../../lib/timeAgo";
import { runRowSubtitle, dedupedTriggerLabel } from "../../lib/routine-run-display";
import { EmptyState } from "../EmptyState";
import { EntityRow } from "../EntityRow";
import { FilterBar, type FilterValue } from "../FilterBar";
import { LiveRunWidget } from "../LiveRunWidget";
import { RoutineHistoryTab } from "../RoutineHistoryTab";
import { RoutineActivityRow } from "../RoutineActivityRow";
import { useRoutineDetail } from "./context";

function getDateWindowOptions(): { value: string; label: string; ms: number | null }[] {
  return [
    { value: "any", label: t("components.operateSections.dateWindowAnyTime", { defaultValue: "Any time" }), ms: null },
    { value: "24h", label: t("components.operateSections.dateWindowLast24h", { defaultValue: "Last 24h" }), ms: 24 * 60 * 60 * 1000 },
    { value: "7d", label: t("components.operateSections.dateWindowLast7d", { defaultValue: "Last 7d" }), ms: 7 * 24 * 60 * 60 * 1000 },
    { value: "30d", label: t("components.operateSections.dateWindowLast30d", { defaultValue: "Last 30d" }), ms: 30 * 24 * 60 * 60 * 1000 },
  ];
}

export function RunsSection() {
  const { t } = useTranslation();
  const ctx = useRoutineDetail();
  const { routine, routineRuns, hasLiveRun, activeIssueId, onOpenRunDialog } = ctx;
  const runs = useMemo(() => routineRuns ?? [], [routineRuns]);

  const [sourceFilter, setSourceFilter] = useState("any");
  const [statusFilter, setStatusFilter] = useState("any");
  const [dateFilter, setDateFilter] = useState("any");

  const sourceOptions = useMemo(
    () => [...new Set(runs.map((run) => run.source))].sort(),
    [runs],
  );
  const statusOptions = useMemo(
    () => [...new Set(runs.map((run) => run.status))].sort(),
    [runs],
  );

  const filtered = useMemo(() => {
    const windowMs = getDateWindowOptions().find((option) => option.value === dateFilter)?.ms ?? null;
    const cutoff = windowMs == null ? null : Date.now() - windowMs;
    return runs.filter((run) => {
      if (sourceFilter !== "any" && run.source !== sourceFilter) return false;
      if (statusFilter !== "any" && run.status !== statusFilter) return false;
      if (cutoff != null && new Date(run.triggeredAt).getTime() < cutoff) return false;
      return true;
    });
  }, [runs, sourceFilter, statusFilter, dateFilter]);

  const activeFilters = useMemo<FilterValue[]>(() => {
    const list: FilterValue[] = [];
    if (sourceFilter !== "any") {
      list.push({
        key: "source",
        label: t("components.operateSections.filterLabelSource", { defaultValue: "Source" }),
        value: sourceFilter,
      });
    }
    if (statusFilter !== "any") {
      list.push({
        key: "status",
        label: t("components.operateSections.filterLabelStatus", { defaultValue: "Status" }),
        value: statusFilter.replaceAll("_", " "),
      });
    }
    if (dateFilter !== "any") {
      const label = getDateWindowOptions().find((option) => option.value === dateFilter)?.label ?? dateFilter;
      list.push({
        key: "date",
        label: t("components.operateSections.filterLabelDate", { defaultValue: "Date" }),
        value: label,
      });
    }
    return list;
  }, [sourceFilter, statusFilter, dateFilter, t]);

  function clearFilters() {
    setSourceFilter("any");
    setStatusFilter("any");
    setDateFilter("any");
  }

  function removeFilter(key: string) {
    if (key === "source") setSourceFilter("any");
    if (key === "status") setStatusFilter("any");
    if (key === "date") setDateFilter("any");
  }

  return (
    <div className="space-y-4">
      {hasLiveRun && activeIssueId ? (
        <LiveRunWidget issueId={activeIssueId} companyId={routine.companyId} />
      ) : null}

      {runs.length === 0 ? (
        <EmptyState
          icon={Play}
          message={t("components.operateSections.noRunsMessage", {
            defaultValue: "No runs yet. Trigger a run from the header or wait for the schedule.",
          })}
          action={t("components.operateSections.runNowAction", { defaultValue: "Run now" })}
          onAction={onOpenRunDialog}
        />
      ) : (
        <>
          {/* Filter chips row (§3.6) */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={sourceFilter} onValueChange={setSourceFilter}>
                <SelectTrigger
                  size="sm"
                  className="h-8 w-auto gap-1.5 text-xs"
                  aria-label={t("components.operateSections.filterBySourceAria", {
                    defaultValue: "Filter by source",
                  })}
                >
                  <span className="text-muted-foreground">
                    {t("components.operateSections.sourcePrefix", { defaultValue: "Source:" })}
                  </span>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">
                    {t("components.operateSections.filterOptionAny", { defaultValue: "any" })}
                  </SelectItem>
                  {sourceOptions.map((source) => (
                    <SelectItem key={source} value={source}>
                      {source}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger
                  size="sm"
                  className="h-8 w-auto gap-1.5 text-xs"
                  aria-label={t("components.operateSections.filterByStatusAria", {
                    defaultValue: "Filter by status",
                  })}
                >
                  <span className="text-muted-foreground">
                    {t("components.operateSections.statusPrefix", { defaultValue: "Status:" })}
                  </span>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">
                    {t("components.operateSections.filterOptionAny", { defaultValue: "any" })}
                  </SelectItem>
                  {statusOptions.map((status) => (
                    <SelectItem key={status} value={status}>
                      {status.replaceAll("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={dateFilter} onValueChange={setDateFilter}>
                <SelectTrigger
                  size="sm"
                  className="h-8 w-auto gap-1.5 text-xs"
                  aria-label={t("components.operateSections.filterByDateAria", {
                    defaultValue: "Filter by date",
                  })}
                >
                  <span className="text-muted-foreground">
                    {t("components.operateSections.datePrefix", { defaultValue: "Date:" })}
                  </span>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {getDateWindowOptions().map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <FilterBar filters={activeFilters} onRemove={removeFilter} onClear={clearFilters} />
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              icon={SlidersHorizontal}
              message={t("components.operateSections.noRunsMatchFilters", {
                defaultValue: "No runs match these filters.",
              })}
              action={t("components.operateSections.clearFiltersAction", { defaultValue: "Clear filters" })}
              onAction={clearFilters}
            />
          ) : (
            <div className="rounded-lg border border-border">
              {filtered.map((run) => {
                const label = dedupedTriggerLabel(run.trigger);
                const title =
                  run.linkedIssue?.title ?? label ?? t("components.operateSections.runFallbackTitle", { defaultValue: "Run" });
                return (
                  <EntityRow
                    key={run.id}
                    leading={
                      <>
                        <Badge variant="outline" className="shrink-0">
                          {run.source}
                        </Badge>
                        <Badge
                          variant={run.status === "failed" ? "destructive" : "secondary"}
                          className="shrink-0"
                        >
                          {run.status.replaceAll("_", " ")}
                        </Badge>
                      </>
                    }
                    identifier={
                      run.linkedIssue
                        ? run.linkedIssue.identifier ?? run.linkedIssue.id.slice(0, 8)
                        : undefined
                    }
                    title={title}
                    subtitle={runRowSubtitle(run, routine.variables)}
                    reserveSubtitleSpace
                    trailing={
                      <span className="text-xs text-muted-foreground">{timeAgo(run.triggeredAt)}</span>
                    }
                    to={
                      run.linkedIssue
                        ? `/issues/${run.linkedIssue.identifier ?? run.linkedIssue.id}`
                        : undefined
                    }
                  />
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function ActivitySection() {
  const { t } = useTranslation();
  const ctx = useRoutineDetail();
  const { activity } = ctx;
  const events = activity ?? [];

  const groups = useMemo(() => {
    const byDay = new Map<string, typeof events>();
    for (const event of events) {
      let label = t("components.operateSections.activityEarlierLabel", { defaultValue: "Earlier" });
      try {
        label = new Date(event.createdAt).toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        });
      } catch {
        /* keep fallback label */
      }
      const bucket = byDay.get(label) ?? [];
      bucket.push(event);
      byDay.set(label, bucket);
    }
    return Array.from(byDay.entries());
  }, [events, t]);

  if (events.length === 0) {
    return (
      <EmptyState
        icon={ActivityIcon}
        message={t("components.operateSections.noActivityMessage", { defaultValue: "No activity yet." })}
      />
    );
  }

  return (
    <div className="space-y-4">
      {groups.map(([day, dayEvents]) => (
        <div key={day}>
          <div className="sticky top-0 bg-background py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {day}
          </div>
          <div>
            {dayEvents.map((event) => (
              <RoutineActivityRow key={event.id} event={event} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function HistorySection() {
  const ctx = useRoutineDetail();
  const {
    routine,
    isEditDirty,
    dirtyFields,
    routineDefaults,
    setEditDraft,
    saveRoutine,
    agentById,
    projectById,
    availableSecrets,
    onHistoryRestoreSecretMaterials,
    onHistoryRestored,
  } = ctx;

  return (
    <RoutineHistoryTab
      routine={routine}
      isEditDirty={isEditDirty}
      dirtyFields={dirtyFields}
      onDiscardEdits={() => setEditDraft(routineDefaults)}
      onSaveEdits={() => {
        if (!saveRoutine.isPending && routine.title.trim()) {
          saveRoutine.mutate();
        }
      }}
      agents={agentById}
      projects={projectById}
      secrets={availableSecrets}
      onRestoreSecretMaterials={onHistoryRestoreSecretMaterials}
      onRestored={onHistoryRestored}
    />
  );
}
