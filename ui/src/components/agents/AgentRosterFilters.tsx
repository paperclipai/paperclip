import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Filter } from "lucide-react";
import type { Agent, Department } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { departmentsApi } from "@/api/departments";
import { agentRosterFilterFields, AGENT_DEPARTMENT_UNASSIGNED, buildAgentRosterIndex, departmentNamesForAgent, emptyAgentRosterFilters, matchesAgentRosterFilters, matchesDepartmentFilter, type AgentRosterFilterField, type AgentRosterFilters as FilterState, type AgentRosterOption } from "@/lib/agent-roster-filters";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { NativeSelect } from "@/components/ui/select";
import { useTx } from "@/i18n/tx";

const emptyAgents: Agent[] = [];
const emptyDepartments: Department[] = [];
const labels: Record<AgentRosterFilterField, string> = { model: "Model", status: "Status", harness: "Harness", connection: "Connection" };
const allLabels: Record<AgentRosterFilterField, string> = { model: "All models", status: "All statuses", harness: "All harnesses", connection: "All connections" };
type RosterFilters = FilterState & { department: string };
const emptyRosterFilters: RosterFilters = { ...emptyAgentRosterFilters, department: "" };

/** Page-owned state keeps filters when switching views and isolates them by company. */
export function useAgentRosterFilters(companyId: string | null, agents: Agent[] = emptyAgents) {
  const [selection, setSelection] = useState({ companyId, filters: emptyRosterFilters });
  const filters = selection.companyId === companyId ? selection.filters : emptyRosterFilters;
  const accounts = useQuery({ queryKey: ["ai-connections", companyId], queryFn: () => aiConnectionsApi.list(companyId!), enabled: !!companyId });
  const departmentQuery = useQuery({
    queryKey: queryKeys.departments.list(companyId ?? ""),
    queryFn: () => departmentsApi.list(companyId!),
    enabled: !!companyId,
  });
  const departments = departmentQuery.data ?? emptyDepartments;
  const index = useMemo(() => buildAgentRosterIndex(agents, accounts.data), [agents, accounts.data]);
  const activeCount = agentRosterFilterFields.filter(field => filters[field]).length + (filters.department ? 1 : 0);
  const departmentOptions = [...departments]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((department) => ({ value: department.id, label: department.name }));
  return {
    filters, options: index.options, departmentOptions, activeCount,
    onChange: (next: RosterFilters) => setSelection({ companyId, filters: next }),
    matches: (agent: Agent) => matchesAgentRosterFilters(index.byAgentId.get(agent.id), filters)
      && matchesDepartmentFilter(agent.id, filters.department, departments),
    departmentLabel: (agentId: string) => {
      const names = departmentNamesForAgent(agentId, departments);
      return names.length ? names.join(", ") : null;
    },
    connectionError: accounts.error,
    departmentError: departmentQuery.error,
    retryConnections: () => void accounts.refetch(),
    retryDepartments: () => void departmentQuery.refetch(),
  };
}

export function AgentRosterFilters({ filters, options, departmentOptions, onChange, activeCount, count, connectionError, departmentError, retryConnections, retryDepartments }: {
  filters: RosterFilters;
  options: Record<AgentRosterFilterField, AgentRosterOption[]>;
  departmentOptions: AgentRosterOption[];
  onChange: (filters: RosterFilters) => void;
  activeCount: number;
  count: number;
  connectionError?: unknown;
  departmentError?: unknown;
  retryConnections: () => void;
  retryDepartments: () => void;
}) {
  const tx = useTx();
  return <div data-canonical-toolbar="agent-filters" role="toolbar" aria-label="Agent filters" className="flex flex-wrap items-center justify-between gap-3">
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Filter agents" title={activeCount ? `Filters: ${activeCount}` : "Filter agents"}
          className={cn("relative shrink-0", activeCount > 0 && "text-blue-600 dark:text-blue-400")}>
          <Filter className="size-3.5" aria-hidden />
          {activeCount > 0 && <span aria-hidden className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-blue-600 text-(length:--text-nano) font-bold text-white">{activeCount}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Agent filter choices" align="start" className="max-h-96 w-72 space-y-3 overflow-y-auto p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Filters</span>
          {activeCount > 0 && <Button variant="ghost" size="sm" onClick={() => onChange(emptyRosterFilters)}>Clear filters</Button>}
        </div>
        {agentRosterFilterFields.map(field => <label key={field} className="block space-y-1 text-xs font-medium text-muted-foreground">
          <span>{labels[field]}</span>
          <NativeSelect aria-label={labels[field]} value={filters[field]} onChange={event => onChange({ ...filters, [field]: event.target.value })}
            className="h-11 text-base md:text-sm">
            <option value="">{allLabels[field]}</option>
            {filters[field] && !options[field].some(option => option.value === filters[field]) && <option value={filters[field]}>Previously selected {labels[field].toLowerCase()}</option>}
            {options[field].map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </NativeSelect>
        </label>)}
        <label className="block space-y-1 text-xs font-medium text-muted-foreground">
          <span>{tx("Department")}</span>
          <NativeSelect aria-label={tx("Department")} value={filters.department} onChange={event => onChange({ ...filters, department: event.target.value })}
            className="h-11 text-base md:text-sm">
            <option value="">{tx("All departments")}</option>
            <option value={AGENT_DEPARTMENT_UNASSIGNED}>{tx("Unassigned")}</option>
            {filters.department && filters.department !== AGENT_DEPARTMENT_UNASSIGNED && !departmentOptions.some(option => option.value === filters.department) && <option value={filters.department}>{tx("Previously selected department")}</option>}
            {departmentOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </NativeSelect>
        </label>
      </PopoverContent>
    </Popover>
    <span className="text-xs text-muted-foreground">{count} {count === 1 ? "agent" : "agents"}</span>
    {!!connectionError && <p role="alert" className="basis-full text-xs text-destructive">Connection names couldn’t be loaded. <Button variant="link" size="sm" onClick={retryConnections}>Retry</Button></p>}
    {!!departmentError && <p role="alert" className="basis-full text-xs text-destructive">{tx("Departments couldn’t be loaded.")} <Button variant="link" size="sm" onClick={retryDepartments}>Retry</Button></p>}
  </div>;
}
