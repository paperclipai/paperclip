import { useCallback, useMemo, useState } from "react";
import {
  ReactFlow,
  MiniMap,
  Background,
  BackgroundVariant,
  MarkerType,
  useReactFlow,
  ReactFlowProvider,
  type NodeTypes,
  type EdgeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Issue } from "@paperclipai/shared";
import { AlertTriangle } from "lucide-react";
import { IssueNode } from "./IssueNode";
import { IssueEdge } from "./IssueEdge";
import { GraphControls } from "./GraphControls";
import { buildGraphNodes, buildGraphEdges } from "./graphUtils";
import { useGraphLayout } from "./useGraphLayout";
import type { EdgeVisibility } from "./types";

interface Agent {
  id: string;
  name: string;
}

interface IssuesGraphProps {
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
}

const NODE_TYPES: NodeTypes = { issue: IssueNode };
const EDGE_TYPES: EdgeTypes = { issueEdge: IssueEdge };
const DEFAULT_EDGE_OPTIONS = {
  markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
};
const NODE_CAP = 500;

function IssuesGraphInner({ issues, agents, liveIssueIds }: IssuesGraphProps) {
  const { fitView } = useReactFlow();

  const [edgeVisibility, setEdgeVisibility] = useState<EdgeVisibility>({
    parent: true,
    workspace: true,
  });

  const liveSet = useMemo(
    () => liveIssueIds ?? new Set<string>(),
    [liveIssueIds],
  );

  const rawNodes = useMemo(
    () => buildGraphNodes(issues, agents, liveSet),
    [issues, agents, liveSet],
  );

  const rawEdges = useMemo(
    () => buildGraphEdges(issues, liveSet, agents),
    [issues, liveSet, agents],
  );

  const { layoutNodes, layoutEdges } = useGraphLayout(rawNodes, rawEdges, edgeVisibility);

  const handleToggleEdge = useCallback((kind: keyof EdgeVisibility) => {
    setEdgeVisibility((prev) => ({ ...prev, [kind]: !prev[kind] }));
  }, []);

  const handleResetLayout = useCallback(() => {
    fitView({ duration: 300 });
  }, [fitView]);

  if (issues.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        No issues to display in graph view.
      </div>
    );
  }

  if (issues.length > NODE_CAP) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <AlertTriangle className="h-5 w-5 text-yellow-500" />
        <p>Too many issues ({issues.length}) for the graph view.</p>
        <p className="text-xs">Narrow your filters to fewer than {NODE_CAP} issues.</p>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-12rem)] w-full rounded-lg border bg-background">
      <ReactFlow
        nodes={layoutNodes}
        edges={layoutEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        nodesConnectable={false}
        edgesFocusable={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} className="!bg-background" />
        <MiniMap
          pannable
          zoomable
          className="!bg-card !border !border-border !rounded-lg !shadow-sm"
          maskColor="rgba(0,0,0,0.1)"
        />
        <GraphControls
          edgeVisibility={edgeVisibility}
          onToggleEdge={handleToggleEdge}
          onResetLayout={handleResetLayout}
          nodeCount={layoutNodes.length}
          edgeCount={layoutEdges.length}
        />
      </ReactFlow>
    </div>
  );
}

export function IssuesGraph(props: IssuesGraphProps) {
  return (
    <ReactFlowProvider>
      <IssuesGraphInner {...props} />
    </ReactFlowProvider>
  );
}
