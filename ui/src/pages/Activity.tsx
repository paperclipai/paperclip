import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { goalsApi } from "../api/goals";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { ActivityRow } from "../components/ActivityRow";
import { PageSkeleton } from "../components/PageSkeleton";
import { Card, Select, ListBox } from "@heroui/react";
import { History } from "lucide-react";
import type { Agent } from "@paperclipai/shared";

export function Activity() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    setBreadcrumbs([{ label: "Activity" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.activity(selectedCompanyId!),
    queryFn: () => activityApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
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

  const filtered =
    data && filter !== "all"
      ? data.filter((e) => e.entityType === filter)
      : data;

  const entityTypes = data
    ? [...new Set(data.map((e) => e.entityType))].sort()
    : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Select
          selectedKey={filter}
          onSelectionChange={(key) => setFilter(String(key))}
          className="w-[160px]"
          aria-label="Filter by type"
          placeholder="All types"
        >
          <Select.Trigger className="h-8 text-xs">
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item id="all" textValue="All types">
                All types
                <ListBox.ItemIndicator />
              </ListBox.Item>
              {entityTypes.map((type) => (
                <ListBox.Item key={type} id={type} textValue={type.charAt(0).toUpperCase() + type.slice(1)}>
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {filtered && filtered.length === 0 && (
        <EmptyState icon={History} message="No activity yet." />
      )}

      {filtered && filtered.length > 0 && (
        <Card className="border-default-200/60">
          <Card.Content className="p-0">
            {filtered.map((event) => (
              <ActivityRow
                key={event.id}
                event={event}
                agentMap={agentMap}
                entityNameMap={entityNameMap}
                entityTitleMap={entityTitleMap}
              />
            ))}
          </Card.Content>
        </Card>
      )}
    </div>
  );
}
