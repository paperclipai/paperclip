import type { WorktreeFileSelector } from "@paperclipai/shared";
import { parseWorktreeFileRef, type ParsedWorktreeFileRef } from "./worktree-file-parser";
import type { WorktreeFileAvailabilityTarget } from "./worktree-file-availability";

const WORKSPACE_FILE_HREF_SCHEME = "workspace-file:";

/**
 * Decides whether a syntactically path-shaped reference may be promoted to a
 * workspace-file link. Returning null keeps the original markdown node, which
 * is the fail-closed default for pending, unavailable, and errored references.
 */
export type WorktreeFileRefResolver = (
  ref: ParsedWorktreeFileRef,
) => WorktreeFileAvailabilityTarget | null;

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

export function buildWorktreeFileHref(ref: ParsedWorktreeFileRef): string {
  const params = new URLSearchParams();
  if (ref.projectId) params.set("projectId", ref.projectId);
  if (ref.workspaceId) params.set("workspaceId", ref.workspaceId);
  if (ref.workspace && ref.workspace !== "auto") params.set("workspace", ref.workspace);
  if (ref.resourceKind === "directory") params.set("kind", "directory");
  params.set("path", ref.path);
  if (ref.line !== null) params.set("line", String(ref.line));
  if (ref.column !== null) params.set("column", String(ref.column));
  if (ref.projectName) params.set("projectName", ref.projectName);
  return `${WORKSPACE_FILE_HREF_SCHEME}?${params.toString()}`;
}

export function parseWorktreeFileHref(href: string | null | undefined): ParsedWorktreeFileRef | null {
  if (!href || typeof href !== "string") return null;
  if (!href.startsWith(WORKSPACE_FILE_HREF_SCHEME)) return null;
  const rest = href.slice(WORKSPACE_FILE_HREF_SCHEME.length);
  const withoutLeadingQuestion = rest.startsWith("?") ? rest.slice(1) : rest;
  const params = new URLSearchParams(withoutLeadingQuestion);
  const path = params.get("path");
  if (!path) return null;
  const projectIdRaw = params.get("projectId");
  const worktreeIdRaw = params.get("workspaceId");
  const hasExplicitTarget = Boolean(projectIdRaw && worktreeIdRaw);
  const projectName = params.get("projectName");
  const worktreeRaw = params.get("workspace");
  const worktree: WorktreeFileSelector = worktreeRaw === "execution" || worktreeRaw === "project"
    ? worktreeRaw
    : "auto";
  const kindRaw = params.get("kind");
  const lineRaw = params.get("line");
  const columnRaw = params.get("column");
  const line = lineRaw ? Number.parseInt(lineRaw, 10) : NaN;
  const column = columnRaw ? Number.parseInt(columnRaw, 10) : NaN;
  return {
    path,
    resourceKind: kindRaw === "directory" || path.endsWith("/") ? "directory" : "file",
    line: Number.isFinite(line) && line > 0 ? line : null,
    column: Number.isFinite(column) && column > 0 ? column : null,
    projectId: hasExplicitTarget ? projectIdRaw : null,
    workspaceId: hasExplicitTarget ? worktreeIdRaw : null,
    projectName: projectName || null,
    workspace: worktree,
    raw: path,
  };
}

function createWorktreeFileLinkNode(ref: ParsedWorktreeFileRef): MarkdownNode {
  return {
    type: "link",
    url: buildWorktreeFileHref(ref),
    children: [{ type: "inlineCode", value: ref.raw }],
  };
}

function parseSingleInlineCodeFileRef(node: MarkdownNode): ParsedWorktreeFileRef | null {
  if (!Array.isArray(node.children) || node.children.length !== 1) return null;
  const [child] = node.children;
  if (child?.type !== "inlineCode" || typeof child.value !== "string") return null;
  return parseWorktreeFileRef(child.value);
}

/**
 * Bind a parsed reference to the workspace that passed preflight so the click
 * reuses that exact target instead of re-running auto discovery.
 */
function applyResolvedTarget(
  ref: ParsedWorktreeFileRef,
  target: WorktreeFileAvailabilityTarget,
): ParsedWorktreeFileRef {
  return {
    ...ref,
    workspace: target.workspace,
    projectId: target.projectId ?? ref.projectId ?? null,
    workspaceId: target.workspaceId ?? ref.workspaceId ?? null,
    projectName: ref.projectName ?? null,
  };
}

/** Returns the target-bound ref when the resolver confirms it is openable. */
function openableRef(
  ref: ParsedWorktreeFileRef,
  resolve: WorktreeFileRefResolver,
): ParsedWorktreeFileRef | null {
  const target = resolve(ref);
  return target ? applyResolvedTarget(ref, target) : null;
}

function rewriteMarkdownTree(node: MarkdownNode, resolve: WorktreeFileRefResolver) {
  if (!Array.isArray(node.children) || node.children.length === 0) return;
  // Existing links whose whole label is a workspace-file code span become
  // file-viewer links instead of issue/external links — but only when the
  // viewer can actually open them. Otherwise the ordinary link is preserved.
  if (node.type === "link") {
    const ref = parseSingleInlineCodeFileRef(node);
    const resolved = ref ? openableRef(ref, resolve) : null;
    if (resolved) {
      node.url = buildWorktreeFileHref(resolved);
    }
    return;
  }
  // Don't descend into other link-like or code blocks; only rewrite inlineCode within flowing text.
  if (node.type === "linkReference" || node.type === "code" || node.type === "definition" || node.type === "html") {
    return;
  }

  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "inlineCode" && typeof child.value === "string") {
      const ref = parseWorktreeFileRef(child.value);
      const resolved = ref ? openableRef(ref, resolve) : null;
      if (resolved) {
        nextChildren.push(createWorktreeFileLinkNode(resolved));
        continue;
      }
    }
    rewriteMarkdownTree(child, resolve);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

/**
 * Promote path-shaped inline code to workspace-file links, gated on `resolve`.
 *
 * The resolver doubles as the registration point: it is called exactly once per
 * candidate reference per parse, which is the set the availability registry
 * needs to check.
 */
export function createRemarkWorktreeFileRefs(resolve: WorktreeFileRefResolver) {
  return function remarkWorktreeFileRefs() {
    return (tree: MarkdownNode) => {
      rewriteMarkdownTree(tree, resolve);
    };
  };
}

export const WORKSPACE_FILE_HREF_PREFIX = WORKSPACE_FILE_HREF_SCHEME;
