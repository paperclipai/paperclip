import type { FolderListItem, FolderListResult } from "@paperclipai/shared";

/**
 * Pure tree helpers for the skill folder browser (Idea A, PAP-14038).
 *
 * The server returns a *flat* {@link FolderListResult}; every folder carries a
 * `parentId`, a canonical slug `path` (root = slug, children = `parent/slug`),
 * a `depth`, and a `systemKey`. Reserved roots have a stable `systemKey`:
 *   - `my`       → "My Skills" (personal folders live beneath it as `my:<userId>`)
 *   - `projects` → "Projects"  (auto-created project folders `project:<id>`)
 *   - `bundled`  → "Bundled"   (read-only; categories `bundled:<slug>`)
 * Everything else at the top level is a plain company folder and is grouped
 * under the virtual "Company" heading in the rail.
 */

export interface FolderTreeNode {
  folder: FolderListItem;
  children: FolderTreeNode[];
}

export type ReservedRootKey = "my" | "projects" | "bundled";

export interface SkillFolderTreeModel {
  /** "My Skills" reserved root, or null when it hasn't been provisioned yet. */
  my: FolderTreeNode | null;
  /** Non-reserved top-level folders, shown under the "Company" heading. */
  company: FolderTreeNode[];
  /** "Projects" reserved root. */
  projects: FolderTreeNode | null;
  /** "Bundled" reserved root (read-only subtree). */
  bundled: FolderTreeNode | null;
  /** Every folder by id, for O(1) lookups. */
  byId: Map<string, FolderListItem>;
  /** Direct child nodes for a given folder id. */
  childrenById: Map<string, FolderTreeNode[]>;
  /** All top-level nodes in reserved-then-company order (for move pickers). */
  roots: FolderTreeNode[];
}

const RESERVED_ROOT_SYSTEM_KEYS = new Set<string>(["my", "projects", "bundled"]);

export function isReservedRootSystemKey(systemKey: string | null | undefined): boolean {
  return Boolean(systemKey && RESERVED_ROOT_SYSTEM_KEYS.has(systemKey));
}

/** True for the Bundled root or anything nested inside it (read-only subtree). */
export function isBundledFolder(folder: Pick<FolderListItem, "path" | "systemKey">): boolean {
  if (folder.systemKey === "bundled" || folder.systemKey?.startsWith("bundled:")) return true;
  return folder.path === "bundled" || folder.path.startsWith("bundled/");
}

/** True for the Projects root or anything nested inside it (auto-managed subtree). */
export function isProjectsFolder(folder: Pick<FolderListItem, "path" | "systemKey">): boolean {
  if (folder.systemKey === "projects" || folder.systemKey?.startsWith("project:")) return true;
  return folder.path === "projects" || folder.path.startsWith("projects/");
}

function sortNodes(nodes: FolderTreeNode[]): void {
  nodes.sort(
    (a, b) => a.folder.position - b.folder.position || a.folder.name.localeCompare(b.folder.name),
  );
  for (const node of nodes) sortNodes(node.children);
}

export function buildSkillFolderTree(folders: FolderListItem[]): SkillFolderTreeModel {
  const byId = new Map<string, FolderListItem>();
  const nodeById = new Map<string, FolderTreeNode>();
  for (const folder of folders) {
    byId.set(folder.id, folder);
    nodeById.set(folder.id, { folder, children: [] });
  }

  const roots: FolderTreeNode[] = [];
  for (const folder of folders) {
    const node = nodeById.get(folder.id)!;
    const parent = folder.parentId ? nodeById.get(folder.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  sortNodes(roots);

  let my: FolderTreeNode | null = null;
  let projects: FolderTreeNode | null = null;
  let bundled: FolderTreeNode | null = null;
  const company: FolderTreeNode[] = [];
  for (const node of roots) {
    switch (node.folder.systemKey) {
      case "my":
        my = node;
        break;
      case "projects":
        projects = node;
        break;
      case "bundled":
        bundled = node;
        break;
      default:
        company.push(node);
    }
  }

  const childrenById = new Map<string, FolderTreeNode[]>();
  for (const [id, node] of nodeById) childrenById.set(id, node.children);

  // Ordered roots: reserved first (My → Projects → Bundled), then company folders.
  const orderedRoots: FolderTreeNode[] = [];
  if (my) orderedRoots.push(my);
  orderedRoots.push(...company);
  if (projects) orderedRoots.push(projects);
  if (bundled) orderedRoots.push(bundled);

  return { my, company, projects, bundled, byId, childrenById, roots: orderedRoots };
}

/** Folder id + every descendant id (the subtree rooted at `folderId`). */
export function subtreeFolderIds(model: SkillFolderTreeModel, folderId: string): Set<string> {
  const out = new Set<string>([folderId]);
  const queue = [folderId];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const child of model.childrenById.get(id) ?? []) {
      if (!out.has(child.folder.id)) {
        out.add(child.folder.id);
        queue.push(child.folder.id);
      }
    }
  }
  return out;
}

/** The chain of folders from the top-level root down to `folderId` (inclusive). */
export function folderBreadcrumbTrail(
  model: SkillFolderTreeModel,
  folderId: string,
): FolderListItem[] {
  const trail: FolderListItem[] = [];
  let current: FolderListItem | undefined = model.byId.get(folderId);
  const guard = new Set<string>();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    trail.unshift(current);
    current = current.parentId ? model.byId.get(current.parentId) : undefined;
  }
  return trail;
}

/** Human label for a reserved root, used when composing breadcrumb prefixes. */
export function reservedRootLabel(folder: Pick<FolderListItem, "systemKey" | "name">): string {
  switch (folder.systemKey) {
    case "my":
      return "My Skills";
    case "projects":
      return "Projects";
    case "bundled":
      return "Bundled";
    default:
      return folder.name;
  }
}

/** Human-readable canonical path used by detail surfaces and breadcrumbs. */
export function skillFolderDisplayPath(
  model: SkillFolderTreeModel,
  folderId: string | null | undefined,
): string | null {
  if (!folderId) return null;
  const trail = folderBreadcrumbTrail(model, folderId);
  if (trail.length === 0) return null;
  const labels = trail.map((folder) => reservedRootLabel(folder));
  if (!trail[0]?.systemKey) labels.unshift("Company");
  return labels.join(" / ");
}

function humanizeFolderPathSegment(segment: string): string {
  return segment
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function skillFolderPathDisplayFallback(folderPath: string | null | undefined): string | null {
  if (!folderPath) return null;
  if (folderPath.includes(" / ")) return folderPath;

  const segments = folderPath.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  const root = segments[0]?.toLowerCase();
  const labels = segments.map(humanizeFolderPathSegment);
  if (root === "my") labels[0] = "My Skills";
  else if (root === "projects") labels[0] = "Projects";
  else if (root === "bundled") labels[0] = "Bundled";
  else labels.unshift("Company");
  return labels.join(" / ");
}

export function emptySkillFolderTree(): SkillFolderTreeModel {
  return buildSkillFolderTree([]);
}

export function treeFromResult(result: FolderListResult | null | undefined): SkillFolderTreeModel {
  return buildSkillFolderTree(result?.folders ?? []);
}
