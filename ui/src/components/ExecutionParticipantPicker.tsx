import { useState } from "react";
import type { Agent, Issue } from "@paperclipai/shared";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { sortAgentsByRecency, getRecentAssigneeIds } from "../lib/recent-assignees";
import {
  buildExecutionPolicy,
  stageParticipantValues,
} from "../lib/issue-execution-policy";
import { cn } from "../lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { User, Eye, ShieldCheck } from "lucide-react";
import { AgentIcon } from "./AgentIconPicker";

type StageType = "review" | "approval";

interface ExecutionParticipantPickerProps {
  issue: Issue;
  stageType: StageType;
  agents: Agent[];
  currentUserId: string | null;
  onUpdate: (data: Record<string, unknown>) => void;
}

export function ExecutionParticipantPicker({
  issue,
  stageType,
  agents,
  currentUserId,
  onUpdate,
}: ExecutionParticipantPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const reviewerValues = stageParticipantValues(issue.executionPolicy, "review");
  const approverValues = stageParticipantValues(issue.executionPolicy, "approval");
  const values = stageType === "review" ? reviewerValues : approverValues;

  const sortedAgents = sortAgentsByRecency(
    agents.filter((a) => a.status !== "terminated"),
    getRecentAssigneeIds(),
  );

  const userLabel = (userId: string | null | undefined) =>
    formatAssigneeUserLabel(userId, currentUserId);
  const creatorUserLabel = userLabel(issue.createdByUserId);

  const agentName = (id: string) => {
    const agent = agents.find((a) => a.id === id);
    return agent?.name ?? id.slice(0, 8);
  };

  const participantLabel = (value: string) => {
    if (value.startsWith("agent:")) return agentName(value.slice("agent:".length));
    if (value.startsWith("user:")) return userLabel(value.slice("user:".length)) ?? "User";
    return value;
  };

  const updatePolicy = (nextValues: string[]) => {
    onUpdate({
      executionPolicy: buildExecutionPolicy({
        existingPolicy: issue.executionPolicy ?? null,
        reviewerValues: stageType === "review" ? nextValues : reviewerValues,
        approverValues: stageType === "approval" ? nextValues : approverValues,
      }),
    });
  };

  const toggle = (value: string) => {
    const next = values.includes(value)
      ? values.filter((v) => v !== value)
      : [...values, value];
    updatePolicy(next);
  };

  const label = stageType === "review" ? "Reviewers" : "Approvers";
  const Icon = stageType === "review" ? Eye : ShieldCheck;

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch(""); }}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer",
            values.length > 0
              ? "border-border text-foreground hover:bg-accent/50"
              : "border-dashed border-border/60 text-muted-foreground hover:border-border hover:text-foreground",
          )}
        >
          <Icon className="h-3 w-3" />
          {values.length > 0 ? (
            <span className="truncate max-w-[100px]">
              {values.map(participantLabel).join(", ")}
            </span>
          ) : (
            <span>{label}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="p-1 w-56" align="start" collisionPadding={16}>
        <input
          className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
          placeholder={`Search ${label.toLowerCase()}...`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />
        <div className="max-h-48 overflow-y-auto overscroll-contain">
          <button
            className={cn(
              "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
              values.length === 0 && "bg-accent",
            )}
            onClick={() => updatePolicy([])}
          >
            No {label.toLowerCase()}
          </button>
          {currentUserId && (
            <button
              className={cn(
                "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                values.includes(`user:${currentUserId}`) && "bg-accent",
              )}
              onClick={() => toggle(`user:${currentUserId}`)}
            >
              <User className="h-3 w-3 shrink-0 text-muted-foreground" />
              Assign to me
            </button>
          )}
          {issue.createdByUserId && issue.createdByUserId !== currentUserId && (
            <button
              className={cn(
                "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                values.includes(`user:${issue.createdByUserId}`) && "bg-accent",
              )}
              onClick={() => toggle(`user:${issue.createdByUserId}`)}
            >
              <User className="h-3 w-3 shrink-0 text-muted-foreground" />
              {creatorUserLabel ?? "Requester"}
            </button>
          )}
          {sortedAgents
            .filter((agent) => {
              if (!search.trim()) return true;
              return agent.name.toLowerCase().includes(search.toLowerCase());
            })
            .map((agent) => {
              const encoded = `agent:${agent.id}`;
              return (
                <button
                  key={agent.id}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                    values.includes(encoded) && "bg-accent",
                  )}
                  onClick={() => toggle(encoded)}
                >
                  <AgentIcon icon={agent.icon} className="shrink-0 h-3 w-3 text-muted-foreground" />
                  {agent.name}
                </button>
              );
            })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
