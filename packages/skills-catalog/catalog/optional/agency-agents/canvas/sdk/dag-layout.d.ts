/**
 * Pure layout math for directed acyclic graphs. Returns positioned node
 * coordinates, edge anchor points, rank bounding boxes, and back-edge flags.
 * Rendering is the caller's responsibility.
 *
 * Handles cycles gracefully: back-edges are detected via DFS, excluded from
 * ranking, and flagged in the output so the caller can render them differently
 * (e.g. dashed arcs).
 */
export type DAGLayoutOptions = {
    /** Nodes to lay out. Only `id` is required. */
    nodes: Array<{
        id: string;
    }>;
    /** Directed edges. */
    edges: Array<{
        from: string;
        to: string;
    }>;
    /** Flow direction. Default `"vertical"` (top-to-bottom). */
    direction?: "vertical" | "horizontal";
    /** Node box width in px. Default 160. */
    nodeWidth?: number;
    /** Node box height in px. Default 40. */
    nodeHeight?: number;
    /** Gap between ranks (layers) in px. Default 64. */
    rankGap?: number;
    /** Gap between sibling nodes in the same rank in px. Default 48. */
    nodeGap?: number;
    /** Padding around the bounding box in px. Default 24. */
    padding?: number;
};
export type DAGLayoutNode = {
    id: string;
    /** Left edge of the node box. */
    x: number;
    /** Top edge of the node box. */
    y: number;
    /** Layer index (0 = root). */
    rank: number;
    /** Position within the rank (0-indexed). */
    order: number;
};
export type DAGLayoutEdge = {
    from: string;
    to: string;
    /** Suggested source anchor point (center of the outgoing side). */
    sourceX: number;
    sourceY: number;
    /** Suggested target anchor point (center of the incoming side). */
    targetX: number;
    targetY: number;
    /** True when this edge was identified as a back-edge (part of a cycle). */
    isBackEdge: boolean;
};
export type DAGLayoutRank = {
    /** Rank index (0 = root). */
    rank: number;
    /** Left edge of the rank bounding box. */
    x: number;
    /** Top edge of the rank bounding box. */
    y: number;
    /** Width of the rank bounding box. */
    width: number;
    /** Height of the rank bounding box. */
    height: number;
    /** Node ids in this rank, in order. */
    nodeIds: string[];
};
export type DAGLayoutResult = {
    nodes: DAGLayoutNode[];
    edges: DAGLayoutEdge[];
    /** Bounding box per rank — useful for drawing layer bands. */
    ranks: DAGLayoutRank[];
    /** The direction used for this layout. */
    direction: "vertical" | "horizontal";
    /** Total width of the bounding box. */
    width: number;
    /** Total height of the bounding box. */
    height: number;
};
/**
 * Compute a hierarchical layout for a directed graph.
 *
 * Returns node positions, edge anchor points, rank bounding boxes, and
 * back-edge flags. The caller handles all rendering.
 *
 * @example
 * ```ts
 * const layout = computeDAGLayout({
 *   nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
 *   edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
 * });
 *
 * // layout.nodes[i].x / .y → position your own SVG/HTML elements
 * // layout.edges[i].sourceX/Y, targetX/Y → draw lines between them
 * // layout.edges[i].isBackEdge → style cycle edges differently
 * // layout.ranks[i] → draw layer bands behind each rank
 * ```
 */
export declare function computeDAGLayout(options: DAGLayoutOptions): DAGLayoutResult;
//# sourceMappingURL=dag-layout.d.ts.map