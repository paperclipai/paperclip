import { useCallback, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Goal, GoalCadence, GoalHealthStatus } from "@ironworksai/shared";
import { GOAL_STATUSES, GOAL_LEVELS } from "@ironworksai/shared";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "./StatusBadge";
import { formatDate, cn, agentUrl } from "../lib/utils";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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

interface AgentOption {
  id: string;
  name: string;
}

function AgentPickerButton({
  current,
  agents,
  onChange,
  children,
}: {
  current: string | null;
  agents: AgentOption[];
  onChange: (value: string | null) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const filtered = search.trim()
    ? agents.filter((a) => a.name.toLowerCase().includes(search.toLowerCase()))
    : agents;
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch(""); }}>
      <PopoverTrigger asChild>
        <button className="cursor-pointer">{children}</button>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-1" align="end">
        <input
          className="mb-1 w-full border-b border-border bg-transparent px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground/50"
          placeholder="Search agents..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />
        <div className="max-h-48 overflow-y-auto overscroll-contain">
          <Button
            variant="ghost"
            size="sm"
            className={cn("w-full justify-start text-xs", !current && "bg-accent")}
            onClick={() => { onChange(null); setOpen(false); }}
          >
            No owner
          </Button>
          {filtered.map((agent) => (
            <Button
              key={agent.id}
              variant="ghost"
              size="sm"
              className={cn("w-full justify-start text-xs", agent.id === current && "bg-accent")}
              onClick={() => { onChange(agent.id); setOpen(false); }}
            >
              {agent.name}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function GoalProperties({ goal, onUpdate }: GoalPropertiesProps) {
  const { selectedCompanyId } = useCompany();

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
            <AgentPickerButton
              current={goal.ownerAgentId}
              agents={agents ?? []}
              onChange={(ownerAgentId) => onUpdate({ ownerAgentId })}
            >
              {ownerAgent ? (
                <span className="text-sm hover:opacity-80 transition-opacity">{ownerAgent.name}</span>
              ) : (
                <span className="text-sm text-muted-foreground hover:opacity-80 transition-opacity">None</span>
              )}
            </AgentPickerButton>
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

        <PropertyRow label="Health">
          <HealthStatusBadge status={goal.healthStatus} />
        </PropertyRow>

        <PropertyRow label="Confidence">
          {onUpdate ? (
            <ConfidenceSlider
              value={goal.confidence ?? 50}
              onChange={(confidence) => onUpdate({ confidence })}
            />
          ) : (
            <span className="text-sm">{goal.confidence ?? "N/A"}</span>
          )}
        </PropertyRow>
      </div>

      <Separator />

      <div className="space-y-1">
        <PropertyRow label="Start Date">
          {onUpdate ? (
            <Input
              type="date"
              className="h-7 w-auto text-xs"
              value={goal.startDate ? goal.startDate.slice(0, 10) : ""}
              onChange={(e) =>
                onUpdate({ startDate: e.target.value || null })
              }
            />
          ) : (
            <span className="text-sm">
              {goal.startDate
                ? new Date(goal.startDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                : "Not set"}
            </span>
          )}
        </PropertyRow>

        <PropertyRow label="Target Date">
          {onUpdate ? (
            <Input
              type="date"
              className="h-7 w-auto text-xs"
              value={goal.targetDate ? goal.targetDate.slice(0, 10) : ""}
              onChange={(e) =>
                onUpdate({ targetDate: e.target.value || null })
              }
            />
          ) : (
            <span className="text-sm">
              {goal.targetDate
                ? new Date(goal.targetDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                : "Not set"}
            </span>
          )}
        </PropertyRow>

        <PropertyRow label="Cadence">
          {onUpdate ? (
            <PickerButton
              current={goal.cadence ?? "none"}
              options={CADENCE_OPTIONS}
              onChange={(cadence) => onUpdate({ cadence: cadence === "none" ? null : cadence })}
            >
              <span className="text-sm capitalize">{goal.cadence ? label(goal.cadence) : "None"}</span>
            </PickerButton>
          ) : (
            <span className="text-sm capitalize">{goal.cadence ? label(goal.cadence) : "None"}</span>
          )}
        </PropertyRow>
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

/* ── Health Status Badge ── */

const HEALTH_STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  on_track: { label: "On Track", className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  at_risk: { label: "At Risk", className: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  off_track: { label: "Off Track", className: "bg-red-500/10 text-red-600 dark:text-red-400" },
  achieved: { label: "Achieved", className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  no_data: { label: "No Data", className: "bg-muted text-muted-foreground" },
};

function HealthStatusBadge({ status }: { status: GoalHealthStatus | null }) {
  const key = status ?? "no_data";
  const cfg = HEALTH_STATUS_CONFIG[key] ?? HEALTH_STATUS_CONFIG.no_data;
  return (
    <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-medium", cfg.className)}>
      {cfg.label}
    </span>
  );
}

/* ── Confidence Slider ── */

const CADENCE_OPTIONS = ["none", "weekly", "monthly", "quarterly", "annual", "custom"] as const;

function ConfidenceSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [local, setLocal] = useState(value);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = useCallback(
    (newVal: number) => {
      setLocal(newVal);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => onChange(newVal), 400);
    },
    [onChange],
  );

  const color =
    local > 66
      ? "text-emerald-600 dark:text-emerald-400"
      : local > 33
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-600 dark:text-red-400";

  return (
    <div className="flex items-center gap-2 w-full">
      <input
        type="range"
        min={0}
        max={100}
        value={local}
        onChange={(e) => handleChange(Number(e.target.value))}
        className="flex-1 h-1.5 accent-foreground cursor-pointer"
      />
      <span className={cn("text-xs font-medium tabular-nums w-8 text-right", color)}>{local}</span>
    </div>
  );
}
