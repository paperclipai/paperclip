import { useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Agent, Goal } from "@paperclipai/shared";
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
import { AgentIcon } from "./AgentIconPicker";
import { Trash2 } from "lucide-react";

interface GoalPropertiesProps {
  goal: Goal;
  onUpdate?: (data: Record<string, unknown>) => void;
  onDelete?: () => void;
  deletePending?: boolean;
  deleteError?: string | null;
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0 w-20 mt-0.5">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0 flex-1 flex-wrap">{children}</div>
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

function AgentOwnerPicker({
  currentAgentId,
  agents,
  onChange,
}: {
  currentAgentId: string | null;
  agents: Agent[];
  onChange: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const currentAgent = currentAgentId
    ? agents.find((a) => a.id === currentAgentId)
    : null;

  const selectableAgents = agents.filter(
    (a) => a.status !== "terminated" || a.id === currentAgentId,
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="cursor-pointer hover:opacity-80 transition-opacity flex items-center gap-1.5 min-w-0"
        >
          {currentAgent ? (
            <>
              <AgentIcon icon={currentAgent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="text-sm truncate">{currentAgent.name}</span>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">None</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-1" align="end">
        <Button
          variant="ghost"
          size="sm"
          className={cn("w-full justify-start text-xs", !currentAgentId && "bg-accent")}
          onClick={() => {
            onChange(null);
            setOpen(false);
          }}
        >
          <span className="text-muted-foreground">None</span>
        </Button>
        {selectableAgents.map((agent) => (
          <Button
            key={agent.id}
            variant="ghost"
            size="sm"
            className={cn(
              "w-full justify-start gap-2 text-xs truncate",
              agent.id === currentAgentId && "bg-accent",
            )}
            onClick={() => {
              onChange(agent.id);
              setOpen(false);
            }}
          >
            <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{agent.name}</span>
            {agent.status === "terminated" && (
              <span className="text-muted-foreground text-xs ml-auto shrink-0">(terminated)</span>
            )}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function GoalProperties({ goal, onUpdate, onDelete, deletePending, deleteError }: GoalPropertiesProps) {
  const { selectedCompanyId } = useCompany();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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
            <AgentOwnerPicker
              currentAgentId={goal.ownerAgentId}
              agents={agents ?? []}
              onChange={(ownerAgentId) => onUpdate({ ownerAgentId })}
            />
          ) : ownerAgent ? (
            <Link
              to={agentUrl(ownerAgent)}
              className="text-sm hover:underline"
            >
              {ownerAgent.name}
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground">None</span>
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

      {onDelete && (
        <>
          <Separator />
          <div className="pt-1">
            {confirmingDelete ? (
              <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                <p className="text-xs text-destructive font-medium">
                  Delete this goal? This action cannot be undone.
                </p>
                {deleteError && (
                  <p className="text-xs text-destructive" role="alert">
                    {deleteError}
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <Button
                    size="xs"
                    variant="destructive"
                    disabled={deletePending}
                    onClick={onDelete}
                  >
                    {deletePending ? "Deleting..." : "Confirm Delete"}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={deletePending}
                    onClick={() => setConfirmingDelete(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                size="xs"
                variant="outline"
                className="w-full justify-start text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setConfirmingDelete(true)}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                Delete Goal
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

