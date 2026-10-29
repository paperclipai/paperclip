import type { WorkspaceFileSelector } from "@paperclipai/shared";
import { parseWorkspaceFileRef, type ParsedWorkspaceFileRef } from "./workspace-file-parser";
import type { WorkspaceFileAvailabilityTarget } from "./workspace-file-availability";

const WORKSPACE_FILE_HREF_SCHEME = "workspace-file:";

/**
 * Decides whether a syntactically path-shaped reference may be promoted to a
 * workspace-file link. Returning null keeps the original markdown node, which
 * is the fail-closed default for pending, unavailable, and errored references.
 */
export type WorkspaceFileRefResolver = (
  ref: ParsedWorkspaceFileRef,
) => WorkspaceFileAvailabilityTarget | null;

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

export function buildWorkspaceFileHref(ref: ParsedWorkspaceFileRef): string {
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

export function parseWorkspaceFileHref(href: string | null | undefined): ParsedWorkspaceFileRef | null {
  if (!href || typeof href !== "string") return null;
  if (!href.startsWith(WORKSPACE_FILE_HREF_SCHEME)) return null;
  const rest = href.slice(WORKSPACE_FILE_HREF_SCHEME.length);
  const withoutLeadingQuestion = rest.startsWith("?") ? rest.slice(1) : rest;
  const params = new URLSearchParams(withoutLeadingQuestion);
  const path = params.get("path");
  if (!path) return null;
  const projectIdRaw = params.get("projectId");
  const workspaceIdRaw = params.get("workspaceId");
  const hasExplicitTarget = Boolean(projectIdRaw && workspaceIdRaw);
  const projectName = params.get("projectName");
  const workspaceRaw = params.get("workspace");
  const workspace: WorkspaceFileSelector = workspaceRaw === "execution" || workspaceRaw === "project"
    ? workspaceRaw
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
    workspaceId: hasExplicitTarget ? workspaceIdRaw : null,
    projectName: projectName || null,
    workspace,
    raw: path,
  };
}

function createWorkspaceFileLinkNode(ref: ParsedWorkspaceFileRef): MarkdownNode {
  return {
    type: "link",
    url: buildWorkspaceFileHref(ref),
    children: [{ type: "inlineCode", value: ref.raw }],
  };
}

function parseSingleInlineCodeFileRef(node: MarkdownNode): ParsedWorkspaceFileRef | null {
  if (!Array.isArray(node.children) || node.children.length !== 1) return null;
  const [child] = node.children;
  if (child?.type !== "inlineCode" || typeof child.value !== "string") return null;
  return parseWorkspaceFileRef(child.value);
}

/**
 * Bind a parsed reference to the workspace that passed preflight so the click
 * reuses that exact target instead of re-running auto discovery.
 */
function applyResolvedTarget(
  ref: ParsedWorkspaceFileRef,
  target: WorkspaceFileAvailabilityTarget,
): ParsedWorkspaceFileRef {
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
  ref: ParsedWorkspaceFileRef,
  resolve: WorkspaceFileRefResolver,
): ParsedWorkspaceFileRef | null {
  const target = resolve(ref);
  return target ? applyResolvedTarget(ref, target) : null;
}

function rewriteMarkdownTree(node: MarkdownNode, resolve: WorkspaceFileRefResolver) {
  if (!Array.isArray(node.children) || node.children.length === 0) return;
  // Existing links whose whole label is a workspace-file code span become
  // file-viewer links instead of issue/external links — but only when the
  // viewer can actually open them. Otherwise the ordinary link is preserved.
  if (node.type === "link") {
    const ref = parseSingleInlineCodeFileRef(node);
    const resolved = ref ? openableRef(ref, resolve) : null;
    if (resolved) {
      node.url = buildWorkspaceFileHref(resolved);
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
      const ref = parseWorkspaceFileRef(child.value);
      const resolved = ref ? openableRef(ref, resolve) : null;
      if (resolved) {
        nextChildren.push(createWorkspaceFileLinkNode(resolved));
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
export function createRemarkWorkspaceFileRefs(resolve: WorkspaceFileRefResolver) {
  return function remarkWorkspaceFileRefs() {
    return (tree: MarkdownNode) => {
      rewriteMarkdownTree(tree, resolve);
    };
  };
}

export const WORKSPACE_FILE_HREF_PREFIX = WORKSPACE_FILE_HREF_SCHEME;
