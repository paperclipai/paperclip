import type { Agent, Issue } from "@paperclipai/shared";
import { User } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { cn } from "../lib/utils";
import { AgentIcon } from "./AgentIconPicker";

type AgentSummary = Pick<Agent, "id" | "name"> & { icon?: string | null };

export function IssueAssigneeIcon({
  issue,
  agents,
  currentUserId,
  className,
}: {
  issue: Pick<Issue, "assigneeAgentId" | "assigneeUserId">;
  agents?: AgentSummary[] | null;
  currentUserId?: string | null;
  className?: string;
}) {
  if (issue.assigneeAgentId) {
    const agent = agents?.find((candidate) => candidate.id === issue.assigneeAgentId) ?? null;
    const label = agent?.name ?? issue.assigneeAgentId.slice(0, 8);
    return (
      <span
        className={cn(
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground",
          className,
        )}
        title={`Assigned to ${label}`}
        aria-label={`Assigned to ${label}`}
      >
        <AgentIcon icon={agent?.icon} className="h-3.5 w-3.5" />
      </span>
    );
  }

  if (issue.assigneeUserId) {
    const label = formatAssigneeUserLabel(issue.assigneeUserId, currentUserId) ?? "User";
    return (
      <Avatar size="xs" className={className} title={`Assigned to ${label}`} aria-label={`Assigned to ${label}`}>
        <AvatarFallback>
          {label === "You" ? "ME" : <User className="h-3 w-3" />}
        </AvatarFallback>
      </Avatar>
    );
  }

  return null;
}
