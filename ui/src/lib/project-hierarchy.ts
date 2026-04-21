export interface ProjectHierarchyProject {
  id: string;
  parentId: string | null;
  name: string;
}

export interface ProjectHierarchyEntry<T extends ProjectHierarchyProject = ProjectHierarchyProject> {
  project: T;
  depth: number;
  ancestorNames: string[];
  hasChildren: boolean;
}

export function projectAncestorNames(
  project: ProjectHierarchyProject,
  projects: ProjectHierarchyProject[],
): string[] {
  const byId = new Map(projects.map((candidate) => [candidate.id, candidate]));
  const names: string[] = [];
  const seen = new Set<string>([project.id]);
  let cursor = project.parentId;

  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const parent = byId.get(cursor);
    if (!parent) break;
    names.unshift(parent.name);
    cursor = parent.parentId;
  }

  return names;
}

export function projectHierarchyLabel(
  project: ProjectHierarchyProject,
  projects: ProjectHierarchyProject[],
): string {
  const ancestors = projectAncestorNames(project, projects);
  return ancestors.length > 0 ? [...ancestors, project.name].join(" / ") : project.name;
}

export function projectDescendantIds(
  projectId: string,
  projects: ProjectHierarchyProject[],
): Set<string> {
  const childrenByParentId = new Map<string, string[]>();
  for (const project of projects) {
    if (!project.parentId) continue;
    const children = childrenByParentId.get(project.parentId) ?? [];
    children.push(project.id);
    childrenByParentId.set(project.parentId, children);
  }

  const descendants = new Set<string>();
  const stack = [...(childrenByParentId.get(projectId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (descendants.has(id)) continue;
    descendants.add(id);
    stack.push(...(childrenByParentId.get(id) ?? []));
  }
  return descendants;
}

export function buildProjectHierarchyEntries<T extends ProjectHierarchyProject>(
  projects: T[],
  allProjects: ProjectHierarchyProject[] = projects,
): ProjectHierarchyEntry<T>[] {
  const visibleById = new Map(projects.map((project) => [project.id, project]));
  const childrenByParentId = new Map<string, T[]>();
  const roots: T[] = [];

  for (const project of projects) {
    if (project.parentId && visibleById.has(project.parentId)) {
      const children = childrenByParentId.get(project.parentId) ?? [];
      children.push(project);
      childrenByParentId.set(project.parentId, children);
    } else {
      roots.push(project);
    }
  }

  const entries: ProjectHierarchyEntry<T>[] = [];
  const visitedIds = new Set<string>();
  const walk = (project: T, path: Set<string>) => {
    if (visitedIds.has(project.id)) return;
    if (path.has(project.id)) {
      visitedIds.add(project.id);
      const ancestorNames = projectAncestorNames(project, allProjects);
      entries.push({
        project,
        depth: ancestorNames.length,
        ancestorNames,
        hasChildren: false,
      });
      return;
    }
    const children = childrenByParentId.get(project.id) ?? [];
    const ancestorNames = projectAncestorNames(project, allProjects);
    visitedIds.add(project.id);
    entries.push({
      project,
      depth: ancestorNames.length,
      ancestorNames,
      hasChildren: children.length > 0,
    });
    const nextPath = new Set(path);
    nextPath.add(project.id);
    for (const child of children) {
      walk(child, nextPath);
    }
  };

  for (const root of roots) {
    walk(root, new Set());
  }
  for (const project of projects) {
    walk(project, new Set());
  }

  return entries;
}
