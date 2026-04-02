import { memo } from "react";
import { Panel } from "@xyflow/react";
import { RotateCcw, GitBranch, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { EdgeVisibility } from "./types";

interface GraphControlsProps {
  edgeVisibility: EdgeVisibility;
  onToggleEdge: (kind: keyof EdgeVisibility) => void;
  onResetLayout: () => void;
  nodeCount: number;
  edgeCount: number;
}

function GraphControlsInner({
  edgeVisibility,
  onToggleEdge,
  onResetLayout,
  nodeCount,
  edgeCount,
}: GraphControlsProps) {
  return (
    <Panel position="top-right" className="flex flex-col gap-2">
      <div className="flex items-center gap-1 rounded-lg border bg-card p-1.5 shadow-sm">
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 gap-1.5 px-2 text-xs",
            edgeVisibility.parent && "bg-accent",
          )}
          onClick={() => onToggleEdge("parent")}
          title="Toggle parent-child edges"
        >
          <GitBranch className="h-3 w-3" />
          <span className="hidden sm:inline">Parent</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 gap-1.5 px-2 text-xs",
            edgeVisibility.workspace && "bg-accent",
          )}
          onClick={() => onToggleEdge("workspace")}
          title="Toggle shared workspace edges"
        >
          <Share2 className="h-3 w-3" />
          <span className="hidden sm:inline">Workspace</span>
        </Button>
        <div className="mx-1 h-4 w-px bg-border" />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onResetLayout}
          title="Reset layout"
        >
          <RotateCcw className="h-3 w-3" />
        </Button>
      </div>

      {/* Legend */}
      <div className="rounded-lg border bg-card p-2 shadow-sm">
        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Legend
        </p>
        <div className="flex flex-col gap-1">
          <LegendItem color="var(--color-muted-foreground)" label="Parent → Child" dashed={false} />
          <LegendItem color="var(--color-blue-400)" label="Shared workspace" dashed />
        </div>
        <div className="mt-1.5 border-t border-border pt-1.5">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Live flows
          </p>
          <div className="flex flex-col gap-1">
            <FlowLegendItem color="var(--color-cyan-400)" label="Delegation →" />
            <FlowLegendItem color="var(--color-emerald-400)" label="← Status" />
          </div>
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">
          {nodeCount} node{nodeCount !== 1 ? "s" : ""} · {edgeCount} edge{edgeCount !== 1 ? "s" : ""}
        </p>
      </div>
    </Panel>
  );
}

function LegendItem({ color, label, dashed }: { color: string; label: string; dashed: boolean }) {
  return (
    <span className="flex items-center gap-2 text-[11px]">
      <svg width="24" height="8" className="shrink-0">
        <line
          x1="0"
          y1="4"
          x2="24"
          y2="4"
          stroke={color}
          strokeWidth="1.5"
          strokeDasharray={dashed ? "4 3" : undefined}
        />
      </svg>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function FlowLegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-2 text-[11px]">
      <svg width="24" height="8" className="shrink-0">
        <circle cx="4" cy="4" r="3" fill={color} />
        <line x1="9" y1="4" x2="22" y2="4" stroke={color} strokeWidth="1" strokeDasharray="2 2" />
      </svg>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

export const GraphControls = memo(GraphControlsInner);
