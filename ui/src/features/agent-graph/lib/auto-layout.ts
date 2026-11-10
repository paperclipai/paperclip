import type { HierarchyMember } from "./hierarchy";

export type LayoutDirection = "TB" | "LR";

export interface LayoutOptions {
  direction: LayoutDirection;
  nodeWidth: number;
  nodeHeight: number;
  siblingGap: number;
  levelGap: number;
  leafWrap: number;
}

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  direction: "TB",
  nodeWidth: 224,
  nodeHeight: 96,
  siblingGap: 32,
  levelGap: 72,
  leafWrap: 8,
};

export interface LayoutPoint {
  x: number;
  y: number;
}

interface TreeNode {
  id: string;
  branches: TreeNode[];
  leaves: string[];
  breadth: number;
}

export function layoutHierarchy(
  members: readonly HierarchyMember[],
  options: Partial<LayoutOptions> = {},
): Map<string, LayoutPoint> {
  const config = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
  const horizontal = config.direction === "LR";
  const breadthSize = horizontal ? config.nodeHeight : config.nodeWidth;
  const depthSize = horizontal ? config.nodeWidth : config.nodeHeight;
  const breadthStep = breadthSize + config.siblingGap;
  const depthStep = depthSize + config.levelGap;
  const leafRowStep = depthSize + config.siblingGap;
  const wrap = Math.max(1, Math.floor(config.leafWrap));

  const ids = new Set<string>();
  for (const member of members) ids.add(member.id);
  const childrenByParent = new Map<string, string[]>();
  const roots: string[] = [];
  for (const member of members) {
    const parent = member.reportsTo !== null && ids.has(member.reportsTo) && member.reportsTo !== member.id
      ? member.reportsTo
      : null;
    if (parent === null) {
      roots.push(member.id);
      continue;
    }
    const siblings = childrenByParent.get(parent);
    if (siblings) siblings.push(member.id);
    else childrenByParent.set(parent, [member.id]);
  }

  const placed = new Set<string>();
  const result = new Map<string, LayoutPoint>();
  const toPoint = (breadth: number, depth: number): LayoutPoint =>
    horizontal ? { x: depth, y: breadth } : { x: breadth, y: depth };

  function buildTree(rootId: string): TreeNode {
    const root: TreeNode = { id: rootId, branches: [], leaves: [], breadth: breadthSize };
    const stack: Array<{ node: TreeNode; visited: boolean }> = [{ node: root, visited: false }];
    placed.add(rootId);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (!frame.visited) {
        frame.visited = true;
        for (const childId of childrenByParent.get(frame.node.id) ?? []) {
          if (placed.has(childId)) continue;
          placed.add(childId);
          if ((childrenByParent.get(childId)?.length ?? 0) === 0) {
            frame.node.leaves.push(childId);
            continue;
          }
          const child: TreeNode = { id: childId, branches: [], leaves: [], breadth: breadthSize };
          frame.node.branches.push(child);
          stack.push({ node: child, visited: false });
        }
        continue;
      }
      stack.pop();
      let childrenBreadth = 0;
      let groups = 0;
      for (const branch of frame.node.branches) {
        childrenBreadth += branch.breadth;
        groups += 1;
      }
      if (frame.node.leaves.length > 0) {
        const columns = Math.min(frame.node.leaves.length, wrap);
        childrenBreadth += columns * breadthSize + (columns - 1) * config.siblingGap;
        groups += 1;
      }
      if (groups > 1) childrenBreadth += (groups - 1) * config.siblingGap;
      frame.node.breadth = Math.max(breadthSize, childrenBreadth);
    }
    return root;
  }

  function placeTree(root: TreeNode, startBreadth: number) {
    const stack: Array<{ node: TreeNode; start: number; depth: number }> = [
      { node: root, start: startBreadth, depth: 0 },
    ];
    while (stack.length > 0) {
      const { node, start, depth } = stack.pop()!;
      result.set(node.id, toPoint(start + (node.breadth - breadthSize) / 2, depth));
      let cursor = start;
      const childDepth = depth + depthStep;
      for (const branch of node.branches) {
        stack.push({ node: branch, start: cursor, depth: childDepth });
        cursor += branch.breadth + config.siblingGap;
      }
      node.leaves.forEach((leafId, index) => {
        const column = index % wrap;
        const row = Math.floor(index / wrap);
        result.set(leafId, toPoint(cursor + column * breadthStep, childDepth + row * leafRowStep));
      });
    }
  }

  let cursor = 0;
  const placeRoot = (rootId: string) => {
    if (placed.has(rootId)) return;
    const tree = buildTree(rootId);
    placeTree(tree, cursor);
    cursor += tree.breadth + config.siblingGap * 2;
  };
  for (const rootId of roots) placeRoot(rootId);
  for (const member of members) placeRoot(member.id);

  return result;
}
