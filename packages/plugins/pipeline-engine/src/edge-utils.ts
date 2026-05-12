import type { EdgeDefinition } from "./types.js";

/**
 * Returns all edges whose destination is the given stage, excluding error edges.
 */
export function getIncomingEdges(stageId: string, edges: EdgeDefinition[]): EdgeDefinition[] {
  return edges.filter((e) => e.to === stageId && e.type !== "error");
}

/**
 * Returns all edges whose source is the given stage.
 */
export function getOutgoingEdges(stageId: string, edges: EdgeDefinition[]): EdgeDefinition[] {
  return edges.filter((e) => e.from === stageId);
}

/**
 * Returns all edges that are not error edges (type !== "error").
 */
export function getForwardEdges(edges: EdgeDefinition[]): EdgeDefinition[] {
  return edges.filter((e) => e.type !== "error");
}

/**
 * Returns all edges where type === "error".
 */
export function getErrorEdges(edges: EdgeDefinition[]): EdgeDefinition[] {
  return edges.filter((e) => e.type === "error");
}

/**
 * Builds a Map<stageId, successorIds[]> from forward edges (error edges excluded).
 */
export function buildAdjacencyFromEdges(edges: EdgeDefinition[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of getForwardEdges(edges)) {
    const existing = adjacency.get(edge.from) ?? [];
    existing.push(edge.to);
    adjacency.set(edge.from, existing);
  }
  return adjacency;
}

/**
 * Returns stage IDs that have no incoming forward edges (i.e., root stages).
 */
export function getRootStageIds(stageIds: string[], edges: EdgeDefinition[]): string[] {
  const forwardEdges = getForwardEdges(edges);
  const hasIncoming = new Set(forwardEdges.map((e) => e.to));
  return stageIds.filter((id) => !hasIncoming.has(id));
}
