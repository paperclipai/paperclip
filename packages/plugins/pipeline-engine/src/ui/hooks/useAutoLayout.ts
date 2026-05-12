import dagre from "dagre";
import type { Node, Edge } from "@xyflow/react";

const NODE_WIDTH = 200;
const NODE_HEIGHT = 90;

/**
 * Compute dagre-based auto-layout positions for the given nodes and edges.
 * Returns a Record mapping node id to {x, y} top-left coordinates.
 */
export function useAutoLayout(
  nodes: Node[],
  edges: Edge[],
): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "TB",
    nodesep: 80,
    ranksep: 120,
  });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const positions: Record<string, { x: number; y: number }> = {};
  for (const node of nodes) {
    const { x, y } = g.node(node.id);
    // dagre returns center coords; ReactFlow uses top-left
    positions[node.id] = {
      x: x - NODE_WIDTH / 2,
      y: y - NODE_HEIGHT / 2,
    };
  }

  return positions;
}
