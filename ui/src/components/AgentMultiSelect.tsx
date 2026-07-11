import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { AgentIcon } from "@/components/AgentIconPicker";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";

export interface AgentMultiSelectOption {
  id: string;
  name: string;
  title?: string | null;
  icon?: string | null;
}

export function AgentMultiSelect({
  agents,
  selectedAgentIds,
  onChange,
  loading = false,
  disabled = false,
  getDescription,
}: {
  agents: AgentMultiSelectOption[];
  selectedAgentIds: Set<string>;
  onChange: (next: Set<string>) => void;
  loading?: boolean;
  disabled?: boolean;
  getDescription?: (agent: AgentMultiSelectOption) => string | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const normalizedFilter = filter.trim().toLowerCase();
  const filteredAgents = useMemo(
    () =>
      agents
        .filter((agent) => {
          const description = getDescription?.(agent) ?? agent.title ?? "";
          return `${agent.name} ${description}`.toLowerCase().includes(normalizedFilter);
        })
        .sort((a, b) => {
          const aSelected = selectedAgentIds.has(a.id);
          const bSelected = selectedAgentIds.has(b.id);
          if (aSelected !== bSelected) return aSelected ? -1 : 1;
          return a.name.localeCompare(b.name);
        }),
    [agents, getDescription, normalizedFilter, selectedAgentIds],
  );
  const selectedCount = selectedAgentIds.size;

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setFilter("");
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="w-full justify-between" disabled={disabled}>
          <span>
            {selectedCount === 0
              ? "Select agents"
              : `${selectedCount} ${selectedCount === 1 ? "agent" : "agents"} selected`}
          </span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <div className="border-b border-border p-3">
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter agents"
            className="h-8"
            autoFocus
          />
        </div>
        {loading ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        ) : agents.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">No agents yet.</div>
        ) : (
          <div className="max-h-60 overflow-y-auto py-1">
            {filteredAgents.map((agent) => {
              const description = getDescription?.(agent) ?? agent.title;
              return (
                <label key={agent.id} className="flex cursor-pointer items-start gap-2 px-3 py-2 hover:bg-accent/30">
                  <Checkbox
                    checked={selectedAgentIds.has(agent.id)}
                    aria-label={`Allow ${agent.name}`}
                    onCheckedChange={(checked) => {
                      const next = new Set(selectedAgentIds);
                      if (checked) next.add(agent.id);
                      else next.delete(agent.id);
                      onChange(next);
                    }}
                  />
                  <AgentIcon icon={agent.icon ?? null} className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium text-foreground">{agent.name}</span>
                    {description ? <span className="truncate text-xs text-muted-foreground">{description}</span> : null}
                  </span>
                </label>
              );
            })}
            {filteredAgents.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground">No matches.</div>
            ) : null}
          </div>
        )}
        <div className="flex items-center justify-between border-t border-border px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {selectedCount === 0 ? "No agents selected" : `${selectedCount} selected`}
          </span>
          <Button type="button" size="sm" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
