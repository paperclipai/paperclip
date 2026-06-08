import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ActivityEvent, Agent } from "@valadrien-os/shared";
import { activityApi } from "../api/activity";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { buildCompanyUserProfileMap } from "../lib/company-members";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { ActivityRow } from "../components/ActivityRow";
import { PageSkeleton } from "../components/PageSkeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { History } from "lucide-react";

const ACTIVITY_PAGE_LIMIT = 200;

function detailString(event: ActivityEvent, ...keys: string[]) {
  const details = event.details;
  for (const key of keys) {
    const value = details?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function activityEntityName(event: ActivityEvent) {
  if (event.entityType === "issue") return detailString(event, "identifier", "issueIdentifier");
  if (event.entityType === "project") return detailString(event, "projectName", "name", "title");
  if (event.entityType === "goal") return detailString(event, "goalTitle", "title", "name");
  return detailString(event, "name", "title");
}

function activityEntityTitle(event: ActivityEvent) {
  if (event.entityType === "issue") return detailString(event, "issueTitle", "title");
  return null;
}

// Group events into a dated blotter: Today / Yesterday / "Month D[, YYYY]".
function dayLabel(d: Date, now: Date): string {
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

function groupByDay(events: ActivityEvent[]): Array<{ label: string; events: ActivityEvent[] }> {
  const now = new Date();
  const map = new Map<string, ActivityEvent[]>();
  const order: string[] = [];
  for (const e of events) {
    const label = dayLabel(new Date(e.createdAt), now);
    const bucket = map.get(label);
    if (bucket) bucket.push(e);
    else { map.set(label, [e]); order.push(label); }
  }
  return order.map((label) => ({ label, events: map.get(label)! }));
}

export function Activity() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    setBreadcrumbs([{ label: "Activity" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: [...queryKeys.activity(selectedCompanyId!), { limit: ACTIVITY_PAGE_LIMIT }],
    queryFn: () => activityApi.list(selectedCompanyId!, { limit: ACTIVITY_PAGE_LIMIT }),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  // Live arrival: flash newly-arrived events (the tape stays alive).
  const [animatedIds, setAnimatedIds] = useState<Set<string>>(new Set());
  const seenRef = useRef<Set<string>>(new Set());
  const hydratedRef = useRef(false);
  const timersRef = useRef<number[]>([]);

  useEffect(() => {
    for (const t of timersRef.current) window.clearTimeout(t);
    timersRef.current = [];
    seenRef.current = new Set();
    hydratedRef.current = false;
    setAnimatedIds(new Set());
  }, [selectedCompanyId]);

  useEffect(() => {
    if (!data || data.length === 0) return;
    const seen = seenRef.current;
    const ids = data.map((e) => e.id);
    if (!hydratedRef.current) {
      for (const id of ids) seen.add(id);
      hydratedRef.current = true;
      return;
    }
    const newIds = ids.filter((id) => !seen.has(id));
    for (const id of ids) seen.add(id);
    if (newIds.length === 0) return;
    setAnimatedIds((prev) => new Set([...prev, ...newIds]));
    const timer = window.setTimeout(() => {
      setAnimatedIds((prev) => {
        const next = new Set(prev);
        for (const id of newIds) next.delete(id);
        return next;
      });
      timersRef.current = timersRef.current.filter((t) => t !== timer);
    }, 980);
    timersRef.current.push(timer);
  }, [data]);

  useEffect(() => () => { for (const t of timersRef.current) window.clearTimeout(t); }, []);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const event of data ?? []) {
      const name = activityEntityName(event);
      if (name) map.set(`${event.entityType}:${event.entityId}`, name);
    }
    return map;
  }, [data, agents]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const event of data ?? []) {
      const title = activityEntityTitle(event);
      if (title) map.set(`${event.entityType}:${event.entityId}`, title);
    }
    return map;
  }, [data]);

  if (!selectedCompanyId) {
    return <EmptyState icon={History} message="Select a company to view activity." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const filtered =
    data && filter !== "all"
      ? data.filter((e) => e.entityType === filter)
      : data;

  const entityTypes = data
    ? [...new Set(data.map((e) => e.entityType))].sort()
    : [];

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl font-medium tracking-tight">Activity</h1>
          {data && data.length > 0 && (
            <div className="mt-1.5 flex items-center gap-2 text-[12.5px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-status-running">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-running opacity-70" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-status-running" />
                </span>
                Live
              </span>
              <span className="text-muted-foreground/50">·</span>
              <span>
                <span className="font-mono text-foreground">{data.length}</span> recent event{data.length === 1 ? "" : "s"}
              </span>
            </div>
          )}
        </div>
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-[140px] h-8 text-xs">
            <SelectValue placeholder="Filter by type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {entityTypes.map((type) => (
              <SelectItem key={type} value={type}>
                {type.charAt(0).toUpperCase() + type.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {filtered && filtered.length === 0 && (
        <EmptyState icon={History} message="No activity yet." />
      )}

      {filtered && filtered.length > 0 && (
        <div className="space-y-5">
          {groupByDay(filtered).map((group) => (
            <div key={group.label}>
              <div className="mb-2 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70">
                {group.label}
                <span className="h-px flex-1 bg-border/70" />
              </div>
              <div className="border border-border divide-y divide-border">
                {group.events.map((event) => (
                  <ActivityRow
                    key={event.id}
                    event={event}
                    agentMap={agentMap}
                    userProfileMap={userProfileMap}
                    entityNameMap={entityNameMap}
                    entityTitleMap={entityTitleMap}
                    className={animatedIds.has(event.id) ? "activity-row-enter" : undefined}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
