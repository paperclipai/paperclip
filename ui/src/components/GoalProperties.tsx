import { useEffect, useState } from "react";
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
import { Input } from "@/components/ui/input";

interface GoalPropertiesProps {
  goal: Goal;
  onUpdate?: (data: Record<string, unknown>) => void;
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

function toDateInputValue(value: Date | string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

// Editable metric fields (target / current / unit / target date). Saves on blur
// so the goal can carry a measurable outcome the Health tab tracks against.
function MetricEditor({ goal, onUpdate }: { goal: Goal; onUpdate: (data: Record<string, unknown>) => void }) {
  const [target, setTarget] = useState(goal.metricTarget ?? "");
  const [current, setCurrent] = useState(goal.metricCurrent ?? "");
  const [unit, setUnit] = useState(goal.metricUnit ?? "");
  const [targetDate, setTargetDate] = useState(toDateInputValue(goal.targetDate));

  // Re-sync local inputs when the goal is refetched after a save elsewhere.
  useEffect(() => {
    setTarget(goal.metricTarget ?? "");
    setCurrent(goal.metricCurrent ?? "");
    setUnit(goal.metricUnit ?? "");
    setTargetDate(toDateInputValue(goal.targetDate));
  }, [goal.metricTarget, goal.metricCurrent, goal.metricUnit, goal.targetDate]);

  const commit = (field: string, raw: string, kind: "number" | "text" | "date") => {
    let value: unknown;
    if (raw.trim() === "") {
      value = null;
    } else if (kind === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      value = n;
    } else {
      value = raw;
    }
    const existing =
      field === "metricTarget"
        ? goal.metricTarget
        : field === "metricCurrent"
          ? goal.metricCurrent
          : field === "metricUnit"
            ? goal.metricUnit
            : toDateInputValue(goal.targetDate);
    const existingNorm = kind === "number" && existing != null ? Number(existing) : existing ?? null;
    if (existingNorm === value) return;
    onUpdate({ [field]: value });
  };

  return (
    <div className="space-y-2">
      <span className="text-xs text-muted-foreground">Metric</span>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-[10px] uppercase text-muted-foreground">Current</label>
          <Input
            value={current}
            inputMode="decimal"
            onChange={(e) => setCurrent(e.target.value)}
            onBlur={(e) => commit("metricCurrent", e.target.value, "number")}
            placeholder="0"
            className="h-7 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase text-muted-foreground">Target</label>
          <Input
            value={target}
            inputMode="decimal"
            onChange={(e) => setTarget(e.target.value)}
            onBlur={(e) => commit("metricTarget", e.target.value, "number")}
            placeholder="10000"
            className="h-7 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase text-muted-foreground">Unit</label>
          <Input
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            onBlur={(e) => commit("metricUnit", e.target.value, "text")}
            placeholder="subscribers"
            className="h-7 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] uppercase text-muted-foreground">Target date</label>
          <Input
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
            onBlur={(e) => commit("targetDate", e.target.value, "date")}
            className="h-7 text-sm"
          />
        </div>
      </div>
    </div>
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
          {ownerAgent ? (
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

      {onUpdate && (
        <>
          <Separator />
          <MetricEditor goal={goal} onUpdate={onUpdate} />
        </>
      )}

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
