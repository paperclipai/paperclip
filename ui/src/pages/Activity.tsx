import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { goalsApi } from "../api/goals";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDocumentVisibility } from "../hooks/useDocumentVisibility";
import {
  getCompanyActivityRefetchInterval,
  normalizeActivityListFilters,
  type ActivityPageFilterState,
} from "../lib/company-activity";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { ActivityRow } from "../components/ActivityRow";
import { PageSkeleton } from "../components/PageSkeleton";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { History } from "lucide-react";
import type { Agent } from "@paperclipai/shared";

export function Activity() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const isDocumentVisible = useDocumentVisibility();
  const [filters, setFilters] = useState<ActivityPageFilterState>({
    agentId: "",
    entityType: "all",
    action: "",
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Activity" }]);
  }, [setBreadcrumbs]);

  const normalizedFilters = useMemo(() => normalizeActivityListFilters(filters), [filters]);
  const activityRefetchInterval = getCompanyActivityRefetchInterval({ isDocumentVisible });

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.activity(selectedCompanyId!, normalizedFilters),
    queryFn: () => activityApi.list(selectedCompanyId!, normalizedFilters),
    enabled: !!selectedCompanyId,
    refetchInterval: activityRefetchInterval,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.identifier ?? i.id.slice(0, 8));
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const p of projects ?? []) map.set(`project:${p.id}`, p.name);
    for (const g of goals ?? []) map.set(`goal:${g.id}`, g.title);
    return map;
  }, [issues, agents, projects, goals]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [issues]);

  if (!selectedCompanyId) {
    return <EmptyState icon={History} message="Select a company to view activity." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const entityTypes = data
    ? [...new Set(data.map((e) => e.entityType).concat(filters.entityType !== "all" ? [filters.entityType] : []))].sort()
    : [];

  const actionOptions = data
    ? [...new Set(data.map((event) => event.action).concat(filters.action ? [filters.action] : []))].sort()
    : (filters.action ? [filters.action] : []);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-end">
        <Select
          value={filters.agentId || "all"}
          onValueChange={(value) => setFilters((current) => ({ ...current, agentId: value === "all" ? "" : value }))}
        >
          <SelectTrigger className="h-8 w-full text-xs lg:w-[180px]">
            <SelectValue placeholder="Filter by agent" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agents</SelectItem>
            {(agents ?? []).map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filters.entityType}
          onValueChange={(value) => setFilters((current) => ({ ...current, entityType: value }))}
        >
          <SelectTrigger className="h-8 w-full text-xs lg:w-[150px]">
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

        <Input
          value={filters.action}
          onChange={(event) => setFilters((current) => ({ ...current, action: event.target.value }))}
          list="activity-action-options"
          placeholder="Filter by action"
          className="h-8 w-full text-xs lg:w-[220px]"
        />
        <datalist id="activity-action-options">
          {actionOptions.map((action) => (
            <option key={action} value={action} />
          ))}
        </datalist>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {data && data.length === 0 && (
        <EmptyState
          icon={History}
          message={
            filters.agentId || filters.entityType !== "all" || filters.action.trim()
              ? "No activity matches the current filters."
              : "No activity yet."
          }
        />
      )}

      {data && data.length > 0 && (
        <div className="border border-border divide-y divide-border">
          {data.map((event) => (
            <ActivityRow
              key={event.id}
              event={event}
              agentMap={agentMap}
              entityNameMap={entityNameMap}
              entityTitleMap={entityTitleMap}
            />
          ))}
        </div>
      )}
    </div>
  );
}
