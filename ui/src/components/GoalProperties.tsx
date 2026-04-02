import { useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Goal } from "@paperclipai/shared";
import { GOAL_STATUSES, GOAL_LEVELS } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "./StatusBadge";
import { formatDate, cn, agentUrl } from "../lib/utils";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Identity } from "./Identity";
import { AgentIcon } from "./AgentIconPicker";
import { User, ArrowUpRight } from "lucide-react";

interface GoalPropertiesProps {
  goal: Goal;
  onUpdate?: (data: Record<string, unknown>) => void;
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0 w-20">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0">{children}</div>
    </div>
  );
}

function label(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function PickerButton({
  current,
  options,
  onChange,
  children,
}: {
  current: string;
  options: readonly string[];
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="cursor-pointer hover:opacity-80 transition-opacity">
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="end">
        {options.map((opt) => (
          <Button
            key={opt}
            variant="ghost"
            size="sm"
            className={cn("w-full justify-start text-xs", opt === current && "bg-accent")}
            onClick={() => {
              onChange(opt);
              setOpen(false);
            }}
          >
            {label(opt)}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function GoalProperties({ goal, onUpdate }: GoalPropertiesProps) {
  const { selectedCompanyId } = useCompany();
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [ownerSearch, setOwnerSearch] = useState("");

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const ownerAgent = goal.ownerAgentId
    ? agents?.find((a) => a.id === goal.ownerAgentId)
    : null;

  const searchTerm = ownerSearch.trim().toLowerCase();
  const filteredAgents = (agents ?? []).filter(
    (a) => a.status !== "terminated" && (!searchTerm || a.name.toLowerCase().includes(searchTerm))
  );

  const parentGoal = goal.parentId
    ? allGoals?.find((g) => g.id === goal.parentId)
    : null;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <PropertyRow label="Status">
          {onUpdate ? (
            <PickerButton
              current={goal.status}
              options={GOAL_STATUSES}
              onChange={(status) => onUpdate({ status })}
            >
              <StatusBadge status={goal.status} />
            </PickerButton>
          ) : (
            <StatusBadge status={goal.status} />
          )}
        </PropertyRow>

        <PropertyRow label="Level">
          {onUpdate ? (
            <PickerButton
              current={goal.level}
              options={GOAL_LEVELS}
              onChange={(level) => onUpdate({ level })}
            >
              <span className="text-sm capitalize">{goal.level}</span>
            </PickerButton>
          ) : (
            <span className="text-sm capitalize">{goal.level}</span>
          )}
        </PropertyRow>

        <PropertyRow label="Owner">
          {onUpdate ? (
            <>
              <Popover open={ownerOpen} onOpenChange={(open) => { setOwnerOpen(open); if (!open) setOwnerSearch(""); }}>
                <PopoverTrigger asChild>
                  <button className="inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors">
                    {ownerAgent ? (
                      <Identity name={ownerAgent.name} size="sm" />
                    ) : (
                      <>
                        <User className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-sm text-muted-foreground">No owner</span>
                      </>
                    )}
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-52 p-1" align="end" collisionPadding={16}>
                  <input
                    className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
                    placeholder="Search agents..."
                    value={ownerSearch}
                    onChange={(e) => setOwnerSearch(e.target.value)}
                    autoFocus
                  />
                  <div className="max-h-48 overflow-y-auto overscroll-contain">
                    <button
                      className={cn(
                        "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                        !goal.ownerAgentId && "bg-accent"
                      )}
                      onClick={() => { onUpdate({ ownerAgentId: null }); setOwnerOpen(false); }}
                    >
                      No owner
                    </button>
                    {filteredAgents.map((a) => (
                      <button
                        key={a.id}
                        className={cn(
                          "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                          a.id === goal.ownerAgentId && "bg-accent"
                        )}
                        onClick={() => { onUpdate({ ownerAgentId: a.id }); setOwnerOpen(false); }}
                      >
                        <AgentIcon icon={a.icon} className="shrink-0 h-3 w-3 text-muted-foreground" />
                        {a.name}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
              {ownerAgent && (
                <Link
                  to={agentUrl(ownerAgent)}
                  className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ArrowUpRight className="h-3 w-3" />
                </Link>
              )}
            </>
          ) : ownerAgent ? (
            <Link to={agentUrl(ownerAgent)} className="hover:underline">
              <Identity name={ownerAgent.name} size="sm" />
            </Link>
          ) : (
            <>
              <User className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">No owner</span>
            </>
          )}
        </PropertyRow>

        {goal.parentId && (
          <PropertyRow label="Parent Goal">
            <Link
              to={`/goals/${goal.parentId}`}
              className="text-sm hover:underline"
            >
              {parentGoal?.title ?? goal.parentId.slice(0, 8)}
            </Link>
          </PropertyRow>
        )}
      </div>

      <Separator />

      <div className="space-y-1">
        <PropertyRow label="Created">
          <span className="text-sm">{formatDate(goal.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label="Updated">
          <span className="text-sm">{formatDate(goal.updatedAt)}</span>
        </PropertyRow>
      </div>
    </div>
  );
}
