import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { AgentIcon } from "@/components/AgentIconPicker";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface AgentMultiSelectOption {
  id: string;
  name: string;
  title?: string | null;
  icon?: string | null;
}

export function AgentSelect({
  agents,
  value,
  onChange,
  placeholder = "Select agent…",
  emptyMessage = "No agents yet.",
  disabled = false,
  triggerClassName,
  id,
}: {
  agents: AgentMultiSelectOption[];
  value: string;
  onChange: (agentId: string) => void;
  placeholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  triggerClassName?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const selectedAgent = agents.find((agent) => agent.id === value);
  const normalizedFilter = filter.trim().toLowerCase();
  const filteredAgents = useMemo(
    () =>
      agents
        .filter((agent) => `${agent.name} ${agent.title ?? ""}`.toLowerCase().includes(normalizedFilter))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [agents, normalizedFilter],
  );

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setFilter("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          size="sm"
          className={cn("w-full justify-between", triggerClassName)}
          disabled={disabled}
        >
          <span className={cn("min-w-0 truncate", !selectedAgent && "text-muted-foreground")}>
            {selectedAgent?.name ?? placeholder}
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <div className="border-b border-border p-3">
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter agents"
            className="h-8"
            autoFocus
          />
        </div>
        {agents.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">{emptyMessage}</div>
        ) : (
          <div className="max-h-60 overflow-y-auto py-1">
            {filteredAgents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-accent/30"
                aria-label={`Select ${agent.name}`}
                onClick={() => {
                  onChange(agent.id);
                  setOpen(false);
                }}
              >
                <AgentIcon icon={agent.icon ?? null} className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">{agent.name}</span>
                  {agent.title ? <span className="truncate text-xs text-muted-foreground">{agent.title}</span> : null}
                </span>
              </button>
            ))}
            {filteredAgents.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground">No matches.</div>
            ) : null}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function AgentMultiSelect({
  agents,
  selectedAgentIds,
  onChange,
  onSave,
  loading = false,
  disabled = false,
  pending = false,
  getDescription,
  isAgentDisabled,
  renderNameSuffix,
  triggerLabel,
  triggerIcon,
  triggerVariant = "outline",
  triggerSize = "default",
  triggerFullWidth = true,
  triggerClassName,
  contentAlign = "start",
  headerContent,
  emptyMessage = "No agents yet.",
  showSelectionPreview = true,
  onOpenChange,
}: {
  agents: AgentMultiSelectOption[];
  selectedAgentIds: Set<string>;
  onChange?: (next: Set<string>) => void;
  onSave?: (next: Set<string>) => void;
  loading?: boolean;
  disabled?: boolean;
  pending?: boolean;
  getDescription?: (agent: AgentMultiSelectOption) => string | null | undefined;
  isAgentDisabled?: (agent: AgentMultiSelectOption) => boolean;
  renderNameSuffix?: (agent: AgentMultiSelectOption) => ReactNode;
  triggerLabel?: string;
  triggerIcon?: ReactNode;
  triggerVariant?: ComponentProps<typeof Button>["variant"];
  triggerSize?: ComponentProps<typeof Button>["size"];
  triggerFullWidth?: boolean;
  triggerClassName?: string;
  contentAlign?: ComponentProps<typeof PopoverContent>["align"];
  headerContent?: ReactNode;
  emptyMessage?: string;
  showSelectionPreview?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [draftAgentIds, setDraftAgentIds] = useState<Set<string>>(new Set(selectedAgentIds));
  const staged = Boolean(onSave);
  const workingAgentIds = staged ? draftAgentIds : selectedAgentIds;

  useEffect(() => {
    if (open && staged) setDraftAgentIds(new Set(selectedAgentIds));
  }, [open, selectedAgentIds, staged]);

  const normalizedFilter = filter.trim().toLowerCase();
  const filteredAgents = useMemo(
    () =>
      agents
        .filter((agent) => {
          const description = getDescription?.(agent) ?? agent.title ?? "";
          return `${agent.name} ${description}`.toLowerCase().includes(normalizedFilter);
        })
        .sort((a, b) => {
          const aSelected = workingAgentIds.has(a.id);
          const bSelected = workingAgentIds.has(b.id);
          if (aSelected !== bSelected) return aSelected ? -1 : 1;
          return a.name.localeCompare(b.name);
        }),
    [agents, getDescription, normalizedFilter, workingAgentIds],
  );
  const selectedCount = selectedAgentIds.size;
  const selectedAgents = agents.filter((agent) => selectedAgentIds.has(agent.id));

  function setSelection(next: Set<string>) {
    if (staged) setDraftAgentIds(next);
    else onChange?.(next);
  }

  return (
    <div className="space-y-2">
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          onOpenChange?.(nextOpen);
          if (!nextOpen) setFilter("");
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant={triggerVariant}
            size={triggerSize}
            className={cn("justify-between", triggerFullWidth && "w-full", triggerClassName)}
            disabled={disabled || pending}
          >
            <span className="flex min-w-0 items-center">
              {triggerIcon}
              <span className="truncate">
                {triggerLabel ?? (selectedCount === 0
                  ? "Select agents"
                  : `${selectedCount} ${selectedCount === 1 ? "agent" : "agents"} selected`)}
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align={contentAlign}>
        <div className="border-b border-border p-3">
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter agents"
            className="h-8"
            autoFocus
          />
          {headerContent}
        </div>
        {loading ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        ) : agents.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">{emptyMessage}</div>
        ) : (
          <div className="max-h-60 overflow-y-auto py-1">
            {filteredAgents.map((agent) => {
              const description = getDescription?.(agent) ?? agent.title;
              const optionDisabled = isAgentDisabled?.(agent) ?? false;
              return (
                <label
                  key={agent.id}
                  className={cn(
                    "flex items-start gap-2 px-3 py-2 hover:bg-accent/30",
                    optionDisabled ? "opacity-60" : "cursor-pointer",
                  )}
                >
                  <Checkbox
                    checked={workingAgentIds.has(agent.id)}
                    disabled={optionDisabled}
                    aria-label={`Allow ${agent.name}`}
                    onCheckedChange={(checked) => {
                      const next = new Set(workingAgentIds);
                      if (checked) next.add(agent.id);
                      else next.delete(agent.id);
                      setSelection(next);
                    }}
                  />
                  <AgentIcon icon={agent.icon ?? null} className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                      <span className="truncate">{agent.name}</span>
                      {renderNameSuffix?.(agent)}
                    </span>
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
              {workingAgentIds.size === 0 ? "No agents selected" : `${workingAgentIds.size} selected`}
            </span>
            <div className="flex items-center gap-2">
              {staged ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
                  Cancel
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  if (staged) onSave?.(draftAgentIds);
                  setOpen(false);
                }}
                disabled={pending}
              >
                {staged ? (pending ? "Saving…" : "Save") : "Done"}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {showSelectionPreview && selectedAgents.length > 0 ? (
        <div className="space-y-0.5">
          {selectedAgents.slice(0, 3).map((agent) => (
            <div key={agent.id} className="flex items-center gap-2 px-1.5 py-1 text-sm">
              <AgentIcon icon={agent.icon ?? null} className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-foreground">{agent.name}</span>
            </div>
          ))}
          {selectedAgents.length > 3 ? (
            <p className="px-1.5 pt-0.5 text-xs text-muted-foreground">and {selectedAgents.length - 3} more</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
