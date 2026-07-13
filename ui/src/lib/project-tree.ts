export const MAX_PROJECT_TREE_DEPTH = 3;

export type ProjectTreeItem = {
  id: string;
  parentProjectId: string | null;
  archivedAt?: Date | string | null;
  name?: string;
};

export type ProjectTreeNode<T extends ProjectTreeItem> = {
  project: T;
  children: ProjectTreeNode<T>[];
  depth: number;
};

export type ParentTargetAvailability = {
  disabled: boolean;
  reason: string | null;
};

export function getDescendantIds<T extends ProjectTreeItem>(projects: T[], projectId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const project of projects) {
    if (!project.parentProjectId) continue;
    const children = childrenByParent.get(project.parentProjectId) ?? [];
    children.push(project.id);
    childrenByParent.set(project.parentProjectId, children);
  }

  const descendants = new Set<string>();
  const pending = [...(childrenByParent.get(projectId) ?? [])];
  while (pending.length > 0) {
    const id = pending.shift()!;
    if (descendants.has(id)) continue;
    descendants.add(id);
    pending.push(...(childrenByParent.get(id) ?? []));
  }
  return descendants;
}

export function getProjectDepth<T extends ProjectTreeItem>(projects: T[], projectId: string): number {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const visited = new Set<string>();
  let current = byId.get(projectId);
  let depth = 1;

  while (current?.parentProjectId && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = byId.get(current.parentProjectId);
    if (!parent) break;
    depth += 1;
    current = parent;
  }
  return depth;
}

export function getSubtreeHeight<T extends ProjectTreeItem>(projects: T[], projectId: string): number {
  const childrenByParent = new Map<string, string[]>();
  for (const project of projects) {
    if (!project.parentProjectId) continue;
    const children = childrenByParent.get(project.parentProjectId) ?? [];
    children.push(project.id);
    childrenByParent.set(project.parentProjectId, children);
  }

  function height(id: string, visited: Set<string>): number {
    if (visited.has(id)) return 1;
    const nextVisited = new Set(visited).add(id);
    const children = childrenByParent.get(id) ?? [];
    return 1 + Math.max(0, ...children.map((childId) => height(childId, nextVisited)));
  }

  return height(projectId, new Set());
}

export function buildProjectTree<T extends ProjectTreeItem>(projects: T[]): ProjectTreeNode<T>[] {
  const activeProjects = projects.filter((project) => !project.archivedAt);
  const byId = new Map(activeProjects.map((project) => [project.id, project]));
  const childrenByParent = new Map<string | null, T[]>();

  for (const project of activeProjects) {
    const parentId = project.parentProjectId && byId.has(project.parentProjectId)
      ? project.parentProjectId
      : null;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(project);
    childrenByParent.set(parentId, children);
  }

  function makeNodes(parentId: string | null, depth: number, visited: Set<string>): ProjectTreeNode<T>[] {
    return (childrenByParent.get(parentId) ?? [])
      .filter((project) => !visited.has(project.id))
      .map((project) => ({
        project,
        depth,
        children: depth < MAX_PROJECT_TREE_DEPTH
          ? makeNodes(project.id, depth + 1, new Set(visited).add(project.id))
          : [],
      }));
  }

  return makeNodes(null, 1, new Set());
}

export function getParentTargetAvailability<T extends ProjectTreeItem>(
  projects: T[],
  movingProjectId: string,
  targetProjectId: string,
): ParentTargetAvailability {
  if (movingProjectId === targetProjectId) {
    return { disabled: true, reason: "A project cannot be its own parent." };
  }

  const target = projects.find((project) => project.id === targetProjectId);
  if (!target) return { disabled: true, reason: "Project is unavailable." };
  if (target.archivedAt) return { disabled: true, reason: "Archived projects cannot contain projects." };
  if (getDescendantIds(projects, movingProjectId).has(targetProjectId)) {
    return { disabled: true, reason: "A project cannot move into one of its descendants." };
  }

  const resultingDepth = getProjectDepth(projects, targetProjectId) + getSubtreeHeight(projects, movingProjectId);
  if (resultingDepth > MAX_PROJECT_TREE_DEPTH) {
    return { disabled: true, reason: `This move would exceed the ${MAX_PROJECT_TREE_DEPTH}-level limit.` };
  }

  return { disabled: false, reason: null };
}

export function getActiveDescendants<T extends ProjectTreeItem>(projects: T[], projectId: string): T[] {
  const descendants = getDescendantIds(projects, projectId);
  return projects.filter((project) => descendants.has(project.id) && !project.archivedAt);
}

export function getActiveDescendantCounts<T extends ProjectTreeItem>(projects: T[]): Map<string, number> {
  const counts = new Map<string, number>();
  const byId = new Map(projects.map((project) => [project.id, project]));
  for (const project of projects) {
    if (project.archivedAt) continue;
    const visited = new Set<string>();
    let parentId = project.parentProjectId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      counts.set(parentId, (counts.get(parentId) ?? 0) + 1);
      parentId = byId.get(parentId)?.parentProjectId ?? null;
    }
  }
  return counts;
}
