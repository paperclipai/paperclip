import { useState } from "react";
import { Link } from "@/lib/router";
import type { OrgNode } from "../api/agents";
import { StatusBadge } from "./StatusBadge";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";

export function OrgTreeView({
  nodes,
  depth = 0,
  hrefFn,
  compact,
}: {
  nodes: OrgNode[];
  depth?: number;
  hrefFn?: (id: string) => string;
  compact?: boolean;
}) {
  return (
    <div>
      {nodes.map((node) => (
        <OrgTreeNode
          key={node.id}
          node={node}
          depth={depth}
          hrefFn={hrefFn}
          compact={compact}
        />
      ))}
    </div>
  );
}

function OrgTreeNode({
  node,
  depth,
  hrefFn,
  compact,
}: {
  node: OrgNode;
  depth: number;
  hrefFn?: (id: string) => string;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.reports.length > 0;

  const paddingLeft = `${depth * (compact ? 12 : 16) + (compact ? 8 : 12)}px`;
  const py = compact ? "py-1.5" : "py-2";

  const content = (
    <>
      {hasChildren ? (
        <button
          className="p-0.5"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setExpanded(!expanded);
          }}
        >
          <ChevronRight
            className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")}
          />
        </button>
      ) : (
        <span className="w-4" />
      )}
      <span
        className={cn(
          "h-2 w-2 rounded-full shrink-0",
          node.status === "active"
            ? "bg-green-400"
            : node.status === "paused"
              ? "bg-yellow-400"
              : node.status === "pending_approval"
                ? "bg-amber-400"
                : node.status === "error"
                  ? "bg-red-400"
                  : "bg-neutral-400"
        )}
      />
      <span className="font-medium flex-1">{node.name}</span>
      <span className="text-xs text-muted-foreground">{node.role}</span>
      <StatusBadge status={node.status} />
    </>
  );

  const className = cn(
    "flex items-center gap-2 px-3 rounded-md text-sm transition-colors",
    py,
    hrefFn
      ? "cursor-pointer hover:bg-accent/50 no-underline text-inherit"
      : "text-inherit"
  );

  return (
    <div>
      {hrefFn ? (
        <Link to={hrefFn(node.id)} className={className} style={{ paddingLeft }}>
          {content}
        </Link>
      ) : (
        <div className={className} style={{ paddingLeft }}>
          {content}
        </div>
      )}
      {hasChildren && expanded && (
        <OrgTreeView
          nodes={node.reports}
          depth={depth + 1}
          hrefFn={hrefFn}
          compact={compact}
        />
      )}
    </div>
  );
}
