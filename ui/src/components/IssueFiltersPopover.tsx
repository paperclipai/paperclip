import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Bot, Filter, HardDrive, Search, User, X } from "lucide-react";
import { PriorityIcon } from "./PriorityIcon";
import { StatusIcon } from "./StatusIcon";
import {
  defaultIssueFilterState,
  issueFilterArraysEqual,
  issueFilterLabel,
  issuePriorityOrder,
  issueQuickFilterPresets,
  issueStatusOrder,
  toggleIssueFilterValue,
  type IssueFilterState,
} from "../lib/issue-filters";
import { formatAssigneeUserLabel } from "../lib/assignees";

type AgentOption = {
  id: string;
  name: string;
};

type ProjectOption = {
  id: string;
  name: string;
};

type LabelOption = {
  id: string;
  name: string;
  color: string;
};

type WorkspaceOption = {
  id: string;
  name: string;
};

type CreatorOption = {
  id: string;
  label: string;
  kind: "agent" | "user";
  searchText?: string;
};

export function IssueFiltersPopover({
  state,
  onChange,
  activeFilterCount,
  agents,
  projects,
  labels,
  currentUserId,
  enableRoutineVisibilityFilter = false,
  buttonVariant = "ghost",
  iconOnly = false,
  workspaces,
  creators,
}: {
  state: IssueFilterState;
  onChange: (patch: Partial<IssueFilterState>) => void;
  activeFilterCount: number;
  agents?: AgentOption[];
  projects?: ProjectOption[];
  labels?: LabelOption[];
  currentUserId?: string | null;
  enableRoutineVisibilityFilter?: boolean;
  buttonVariant?: "ghost" | "outline";
  iconOnly?: boolean;
  workspaces?: WorkspaceOption[];
  creators?: CreatorOption[];
}) {
  const [creatorSearch, setCreatorSearch] = useState("");
  const creatorOptions = creators ?? [];
  const creatorOptionById = useMemo(
    () => new Map(creatorOptions.map((option) => [option.id, option])),
    [creatorOptions],
  );
  const normalizedCreatorSearch = creatorSearch.trim().toLowerCase();
  const visibleCreatorOptions = useMemo(() => {
    if (!normalizedCreatorSearch) return creatorOptions;
    return creatorOptions.filter((option) =>
      `${option.label} ${option.searchText ?? ""}`.toLowerCase().includes(normalizedCreatorSearch),
    );
  }, [creatorOptions, normalizedCreatorSearch]);
  const selectedCreatorOptions = useMemo(
    () => state.creators.map((creatorId) => {
      const knownOption = creatorOptionById.get(creatorId);
      if (knownOption) return knownOption;
      if (creatorId.startsWith("agent:")) {
        const agentId = creatorId.slice("agent:".length);
        return { id: creatorId, label: agentId.slice(0, 8), kind: "agent" as const };
      }
      const userId = creatorId.startsWith("user:") ? creatorId.slice("user:".length) : creatorId;
      return {
        id: creatorId,
        label: formatAssigneeUserLabel(userId, currentUserId) ?? userId.slice(0, 5),
        kind: "user" as const,
      };
    }),
    [creatorOptionById, currentUserId, state.creators],
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={buttonVariant} size={iconOnly ? "icon" : "sm"} className={`text-xs ${iconOnly ? "relative h-8 w-8 shrink-0" : ""} ${activeFilterCount > 0 ? "text-blue-600 dark:text-blue-400" : ""}`} title={iconOnly ? (activeFilterCount > 0 ? `Filters: ${activeFilterCount}` : "Filter") : undefined}>
          <Filter className={iconOnly ? "h-3.5 w-3.5" : "h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1"} />
          {!iconOnly && <span className="hidden sm:inline">{activeFilterCount > 0 ? `Filters: ${activeFilterCount}` : "Filter"}</span>}
          {!iconOnly && activeFilterCount > 0 ? <span className="ml-0.5 text-[10px] font-medium sm:hidden">{activeFilterCount}</span> : null}
          {iconOnly && activeFilterCount > 0 ? <span className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-600 text-[9px] font-bold text-white">{activeFilterCount}</span> : null}
          {!iconOnly && activeFilterCount > 0 ? (
            <X
              className="ml-1 hidden h-3 w-3 sm:block"
              onClick={(event) => {
                event.stopPropagation();
                onChange(defaultIssueFilterState);
              }}
            />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(780px,calc(100vw-2rem))] max-h-[min(80vh,42rem)] overflow-y-auto overscroll-contain p-0"
      >
        <div className="space-y-3 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Filters</span>
            {activeFilterCount > 0 ? (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => onChange(defaultIssueFilterState)}
              >
                Clear
              </button>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <span className="text-xs text-muted-foreground">Quick filters</span>
            <div className="flex flex-wrap gap-1.5">
              {issueQuickFilterPresets.map((preset) => {
                const isActive = issueFilterArraysEqual(state.statuses, preset.statuses);
                return (
                  <button
                    key={preset.label}
                    type="button"
                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      isActive
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                    }`}
                    onClick={() => onChange({ statuses: isActive ? [] : [...preset.statuses] })}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="border-t border-border" />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="min-w-0 space-y-3">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Status</span>
                <div className="space-y-0.5">
                  {issueStatusOrder.map((status) => (
                    <label key={status} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                      <Checkbox
                        checked={state.statuses.includes(status)}
                        onCheckedChange={() => onChange({ statuses: toggleIssueFilterValue(state.statuses, status) })}
                      />
                      <StatusIcon status={status} />
                      <span className="text-sm">{issueFilterLabel(status)}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Priority</span>
                <div className="space-y-0.5">
                  {issuePriorityOrder.map((priority) => (
                    <label key={priority} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                      <Checkbox
                        checked={state.priorities.includes(priority)}
                        onCheckedChange={() => onChange({ priorities: toggleIssueFilterValue(state.priorities, priority) })}
                      />
                      <PriorityIcon priority={priority} />
                      <span className="text-sm">{issueFilterLabel(priority)}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="min-w-0 space-y-3">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Assignee</span>
                <div className="max-h-32 space-y-0.5 overflow-y-auto">
                  <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                    <Checkbox
                      checked={state.assignees.includes("__unassigned")}
                      onCheckedChange={() => onChange({ assignees: toggleIssueFilterValue(state.assignees, "__unassigned") })}
                    />
                    <span className="text-sm">No assignee</span>
                  </label>
                  {currentUserId ? (
                    <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                      <Checkbox
                        checked={state.assignees.includes("__me")}
                        onCheckedChange={() => onChange({ assignees: toggleIssueFilterValue(state.assignees, "__me") })}
                      />
                      <User className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-sm">Me</span>
                    </label>
                  ) : null}
                  {(agents ?? []).map((agent) => (
                    <label key={agent.id} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                      <Checkbox
                        checked={state.assignees.includes(agent.id)}
                        onCheckedChange={() => onChange({ assignees: toggleIssueFilterValue(state.assignees, agent.id) })}
                      />
                      <span className="text-sm">{agent.name}</span>
                    </label>
                  ))}
                </div>
              </div>

              {creatorOptions.length > 0 ? (
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Creator</span>
                  {selectedCreatorOptions.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {selectedCreatorOptions.map((creator) => (
                        <Badge key={creator.id} variant="secondary" className="gap-1 pr-1">
                          {creator.kind === "agent" ? <Bot className="h-3 w-3" /> : <User className="h-3 w-3" />}
                          <span>{creator.label}</span>
                          <button
                            type="button"
                            className="rounded-full p-0.5 hover:bg-accent"
                            onClick={() => onChange({ creators: state.creators.filter((value) => value !== creator.id) })}
                            aria-label={`Remove creator ${creator.label}`}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={creatorSearch}
                      onChange={(event) => setCreatorSearch(event.target.value)}
                      placeholder="Search creators..."
                      className="h-8 pl-7 text-xs"
                    />
                  </div>
                  <div className="max-h-32 space-y-0.5 overflow-y-auto">
                    {visibleCreatorOptions.length > 0 ? visibleCreatorOptions.map((creator) => {
                      const selected = state.creators.includes(creator.id);
                      return (
                        <button
                          key={creator.id}
                          type="button"
                          className={`flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm ${
                            selected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                          }`}
                          onClick={() => onChange({ creators: toggleIssueFilterValue(state.creators, creator.id) })}
                        >
                          {creator.kind === "agent" ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
                          <span className="min-w-0 flex-1 truncate">{creator.label}</span>
                          {selected ? <X className="h-3 w-3" /> : null}
                        </button>
                      );
                    }) : (
                      <div className="px-2 py-1 text-xs text-muted-foreground">No creators match.</div>
                    )}
                  </div>
                </div>
              ) : null}

              {projects && projects.length > 0 ? (
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Project</span>
                  <div className="max-h-32 space-y-0.5 overflow-y-auto">
                    {projects.map((project) => (
                      <label key={project.id} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                        <Checkbox
                          checked={state.projects.includes(project.id)}
                          onCheckedChange={() => onChange({ projects: toggleIssueFilterValue(state.projects, project.id) })}
                        />
                        <span className="text-sm">{project.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="min-w-0 space-y-3">
              {labels && labels.length > 0 ? (
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Labels</span>
                  <div className="max-h-32 space-y-0.5 overflow-y-auto">
                    {labels.map((label) => (
                      <label key={label.id} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                        <Checkbox
                          checked={state.labels.includes(label.id)}
                          onCheckedChange={() => onChange({ labels: toggleIssueFilterValue(state.labels, label.id) })}
                        />
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: label.color }} />
                        <span className="text-sm">{label.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}

              {workspaces && workspaces.length > 0 ? (
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Workspace</span>
                  <div className="max-h-32 space-y-0.5 overflow-y-auto">
                    {workspaces.map((workspace) => (
                      <label key={workspace.id} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                        <Checkbox
                          checked={state.workspaces.includes(workspace.id)}
                          onCheckedChange={() => onChange({ workspaces: toggleIssueFilterValue(state.workspaces, workspace.id) })}
                        />
                        <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-sm">{workspace.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}

              {enableRoutineVisibilityFilter ? (
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Visibility</span>
                  <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                    <Checkbox
                      checked={state.hideRoutineExecutions}
                      onCheckedChange={(checked) => onChange({ hideRoutineExecutions: checked === true })}
                    />
                    <span className="text-sm">Hide routine runs</span>
                  </label>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
