import { memo, useCallback } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useNavigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { issueStatusIcon, issueStatusIconDefault } from "../../lib/status-colors";
import { PriorityIcon } from "../PriorityIcon";
import { createIssueDetailPath } from "../../lib/issueDetailBreadcrumb";
import type { GraphNodeData } from "./types";

function IssueNodeInner({ data }: NodeProps) {
  const navigate = useNavigate();
  const { issue, agentName, isLive } = data as GraphNodeData;
  const statusColor = issueStatusIcon[issue.status] ?? issueStatusIconDefault;
  const identifier = issue.identifier ?? issue.id.slice(0, 8);
  const isDone = issue.status === "done";

  const handleClick = useCallback(() => {
    const path = createIssueDetailPath(issue.identifier ?? issue.id);
    navigate(path);
  }, [navigate, issue.identifier, issue.id]);

  return (
    <>
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-border !border-background" />
      <div
        onClick={handleClick}
        className={cn(
          "group relative flex cursor-pointer flex-col gap-1 rounded-lg border bg-card px-3 py-2 shadow-sm transition-shadow hover:shadow-md",
          "w-[200px]",
          isDone && "opacity-60",
        )}
      >
        <div className="flex items-center gap-1.5">
          <span className={cn("relative inline-flex h-3 w-3 shrink-0 rounded-full border-2", statusColor)}>
            {isDone && <span className="absolute inset-0 m-auto h-1.5 w-1.5 rounded-full bg-current" />}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{identifier}</span>
          <PriorityIcon priority={issue.priority} className="ml-auto" />
          {isLive && (
            <span className="h-2 w-2 shrink-0 rounded-full bg-cyan-400 animate-pulse" title="Live" />
          )}
        </div>
        <p className="line-clamp-2 text-xs leading-tight">{issue.title}</p>
        {agentName && (
          <span className="mt-auto truncate text-[10px] text-muted-foreground">{agentName}</span>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-border !border-background" />
    </>
  );
}

export const IssueNode = memo(IssueNodeInner);
