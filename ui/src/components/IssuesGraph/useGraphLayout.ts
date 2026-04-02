import { useMemo } from "react";
import Dagre from "@dagrejs/dagre";
import type { GraphNode, GraphEdge, EdgeVisibility } from "./types";
import { GRAPH_NODE_WIDTH, GRAPH_NODE_HEIGHT } from "./graphUtils";

const HORIZONTAL_GAP = 60;
const VERTICAL_GAP = 24;

export function useGraphLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  edgeVisibility: EdgeVisibility,
): { layoutNodes: GraphNode[]; layoutEdges: GraphEdge[] } {
  return useMemo(() => {
    if (nodes.length === 0) return { layoutNodes: [], layoutEdges: [] };

    const visibleEdges = edges.filter((e) => {
      const kind = e.data?.kind;
      if (kind === "parent" && !edgeVisibility.parent) return false;
      if (kind === "workspace" && !edgeVisibility.workspace) return false;
      return true;
    });

    const g = new Dagre.graphlib.Graph({ directed: true, compound: false, multigraph: false });
    g.setGraph({
      rankdir: "LR",
      nodesep: VERTICAL_GAP,
      ranksep: HORIZONTAL_GAP,
      marginx: 20,
      marginy: 20,
    });
    g.setDefaultEdgeLabel(() => ({}));

    for (const node of nodes) {
      g.setNode(node.id, { width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT });
    }

    const parentEdges = edges.filter((e) => e.data?.kind === "parent");
    for (const edge of parentEdges) {
      g.setEdge(edge.source, edge.target);
    }

    Dagre.layout(g);

    const layoutNodes: GraphNode[] = nodes.map((n) => {
      const pos = g.node(n.id);
      return {
        ...n,
        position: {
          x: (pos.x ?? 0) - GRAPH_NODE_WIDTH / 2,
          y: (pos.y ?? 0) - GRAPH_NODE_HEIGHT / 2,
        },
      };
    });

    return { layoutNodes, layoutEdges: visibleEdges };
  }, [nodes, edges, edgeVisibility]);
}
