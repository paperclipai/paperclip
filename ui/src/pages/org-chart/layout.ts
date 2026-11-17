import type { OrgNode } from "../../api/agents";

export interface ChartGeometry {
  leaderWidth: number; leaderHeight: number;
  managerWidth: number; managerHeight: number;
  memberWidth: number; memberHeight: number;
  gap: number; levelGap: number; padding: number; taskHeight: number;
  sparsePadding: number; fitZoomMax: number; sparseFitZoomMax: number;
}
export interface LayoutNode {
  id: string; name: string; role: string; status: string;
  x: number; y: number; width: number; height: number;
  depth: number; tier: 1 | 2 | 3; leader: boolean; children: LayoutNode[];
  offsetX?: number; offsetY?: number;
}
interface Block { roots: LayoutNode[]; width: number; height: number }
function shift(node: LayoutNode, x: number, y: number) {
  node.offsetX = (node.offsetX ?? 0) + x;
  node.offsetY = (node.offsetY ?? 0) + y;
}
function resolvePositions(node: LayoutNode, x = 0, y = 0) {
  x += node.offsetX ?? 0; y += node.offsetY ?? 0;
  node.x += x; node.y += y;
  node.children.forEach(child => resolvePositions(child, x, y));
  delete node.offsetX; delete node.offsetY;
}
function pack(blocks: Block[], columns: number, gap: number): Block {
  const rows: Block[][] = [];
  for (let i = 0; i < blocks.length; i += columns) rows.push(blocks.slice(i, i + columns));
  const width = Math.max(0, ...rows.map(row => row.reduce((sum, b) => sum + b.width, 0) + (row.length - 1) * gap));
  let y = 0;
  const roots: LayoutNode[] = [];
  for (const row of rows) {
    // Keep partial rows aligned so connector lanes stay between columns.
    let x = 0;
    for (const block of row) {
      block.roots.forEach(node => { shift(node, x, y); roots.push(node); });
      x += block.width + gap;
    }
    y += Math.max(...row.map(b => b.height)) + gap;
  }
  return { roots, width, height: Math.max(0, y - gap) };
}

/** Pack three fixed card tiers; keep source traversal and packing passes bounded. */
export function layoutOrganization(roots: OrgNode[], viewport: { width: number; height: number }, g: ChartGeometry): Block & { maxFitZoom: number } {
  let count = 0;
  const snapshot = (node: OrgNode): OrgNode => {
    count++;
    const { reports, ...fields } = node;
    return { ...fields, reports: reports.map(snapshot) };
  };
  const source = roots.map(snapshot);
  // Small organizations should feel centered and roomy, not like oversized posters.
  const density = Math.min(1, Math.max(0, (count - 4) / 8));
  const padding = g.sparsePadding + (g.padding - g.sparsePadding) * density;
  const maxFitZoom = g.sparseFitZoomMax + (g.fitZoomMax - g.sparseFitZoomMax) * density;
  if (!source.length) return { roots: [], width: 0, height: 0, maxFitZoom };
  const availableWidth = Math.max(1, viewport.width - g.padding);
  const availableHeight = Math.max(1, viewport.height - g.padding);
  const fitScale = (block: Block) => Math.min(availableWidth / block.width, availableHeight / block.height, maxFitZoom);
  const arrange = (columns: number): Block => {
    const build = (node: OrgNode, depth: number): Block => {
      const reports = node.reports;
      const leader = reports.length > 0;
      const tier = !leader ? 3 : depth === 0 ? 1 : 2;
      const width = tier === 1 ? g.leaderWidth : tier === 2 ? g.managerWidth : g.memberWidth;
      const height = tier === 1 ? g.leaderHeight : tier === 2 ? g.managerHeight : g.memberHeight;
      const childBlocks = reports.map(child => build(child, depth + 1));
      const teams = childBlocks.filter(block => block.roots[0].leader);
      const members = childBlocks.filter(block => !block.roots[0].leader);
      // A mixed leadership team keeps its individual contributors in a compact
      // side column, instead of placing them below the deepest reporting branch.
      const branches = teams.length && members.length
        ? [...teams, pack(members, 1, g.gap)]
        : childBlocks;
      const children = pack(branches, columns, g.gap);
      const blockWidth = Math.max(width, children.width);
      children.roots.forEach(child => shift(child, (blockWidth - children.width) / 2, height + g.levelGap));
      return {
        roots: [{ id: node.id, name: node.name, role: node.role, status: node.status, x: (blockWidth - width) / 2, y: 0, width, height, depth, tier, leader, children: children.roots }],
        width: blockWidth,
        height: height + (children.roots.length ? g.levelGap + children.height : 0),
      };
    };
    const candidate = pack(source.map(root => build(root, 0)), columns, g.levelGap);
    return { ...candidate, width: candidate.width + padding * 2, height: candidate.height + padding * 2 };
  };
  let best = arrange(1);
  let bestScore = -Infinity;
  for (let columns = 1; columns <= 6; columns++) {
    const candidate = columns === 1 ? best : arrange(columns);
    const scale = fitScale(candidate);
    const coverage = candidate.width * candidate.height * scale * scale / Math.max(1, viewport.width * viewport.height);
    const score = scale * (0.8 + coverage * 0.2);
    if (score > bestScore) {
      best = candidate; bestScore = score;
    }
  }
  best.roots.forEach(root => { shift(root, padding, padding); resolvePositions(root); });
  return { ...best, maxFitZoom };
}

export interface ReportingRoute {
  parent: LayoutNode;
  child: LayoutNode;
  points: Array<{ x: number; y: number }>;
  path: string;
}

/** Give every relationship a separate port, horizontal track, and column lane. */
export function routeReportingEdges(roots: LayoutNode[], gap: number): ReportingRoute[] {
  const routes: ReportingRoute[] = [];
  const visit = (parent: LayoutNode) => {
    const columns = new Map<number, LayoutNode[]>();
    for (const child of parent.children) {
      const column = columns.get(child.x) ?? [];
      column.push(child);
      columns.set(child.x, column);
    }
    const lanes: Array<{ child: LayoutNode; x: number; port: number }> = [];
    for (const column of columns.values()) {
      column.sort((a, b) => a.y - b.y);
      column.forEach((child, row) => lanes.push({
        child, x: child.x - gap * (row + 1) / (column.length + 1), port: 0,
      }));
    }
    lanes.sort((a, b) => a.x - b.x);
    lanes.forEach((lane, index) => {
      lane.port = parent.x + gap / 2 + (parent.width - gap) * (index + 1) / (lanes.length + 1);
    });
    const left = lanes.filter(lane => lane.x < lane.port);
    const right = lanes.filter(lane => lane.x >= lane.port).reverse();
    const tracks = [...left, ...right];
    const bottom = parent.y + parent.height;
    const firstRow = Math.min(...parent.children.map(child => child.y));
    tracks.forEach((lane, index) => {
      const trackY = bottom + (firstRow - bottom) * (index + 1) / (tracks.length + 1);
      const endY = lane.child.y + lane.child.height / 2;
      const points = [
        { x: lane.port, y: bottom }, { x: lane.port, y: trackY },
        { x: lane.x, y: trackY }, { x: lane.x, y: endY }, { x: lane.child.x, y: endY },
      ];
      routes.push({ parent, child: lane.child, points, path: points.map((point, i) => `${i ? "L" : "M"} ${point.x} ${point.y}`).join(" ") });
    });
    parent.children.forEach(visit);
  };
  roots.forEach(visit);
  return routes;
}
