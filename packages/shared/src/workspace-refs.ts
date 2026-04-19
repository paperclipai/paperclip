/**
 * Cross-workspace file reference utilities.
 *
 * Format: `[workspace:<workspace-name>]<file-path>`
 * Example: `[workspace:frontend]/src/App.tsx`
 *
 * When crossWorkspaceRefs is enabled on an agent's workspaceConfig,
 * agents can reference files from non-primary workspaces using this format.
 */

export interface WorkspaceFileRef {
  workspaceName: string;
  filePath: string;
  raw: string;
}

const WORKSPACE_REF_REGEX = /\[workspace:([^\]]+)\]([^\s]+)/g;

/**
 * Parse all workspace file references from a text string.
 */
export function parseWorkspaceFileRefs(text: string): WorkspaceFileRef[] {
  const refs: WorkspaceFileRef[] = [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(WORKSPACE_REF_REGEX.source, "g");
  while ((match = regex.exec(text)) !== null) {
    refs.push({
      workspaceName: match[1]!,
      filePath: match[2]!,
      raw: match[0],
    });
  }
  return refs;
}

/**
 * Build a workspace file reference string.
 */
export function buildWorkspaceFileRef(workspaceName: string, filePath: string): string {
  return `[workspace:${workspaceName}]${filePath}`;
}

/**
 * Resolve a workspace file reference to an absolute path given a workspace map.
 * Returns null if the workspace is not found.
 */
export function resolveWorkspaceFileRef(
  ref: WorkspaceFileRef,
  workspaceMap: Map<string, { cwd: string }>,
): string | null {
  const workspace = workspaceMap.get(ref.workspaceName);
  if (!workspace) return null;
  const cwd = workspace.cwd.endsWith("/") ? workspace.cwd : workspace.cwd + "/";
  const normalizedPath = ref.filePath.startsWith("/") ? ref.filePath.slice(1) : ref.filePath;
  return cwd + normalizedPath;
}

/**
 * Replace workspace file references in text with resolved absolute paths.
 * References that cannot be resolved are left as-is.
 */
export function expandWorkspaceFileRefs(text: string, workspaceMap: Map<string, { cwd: string }>): string {
  return text.replace(new RegExp(WORKSPACE_REF_REGEX.source, "g"), (match, workspaceName: string, filePath: string) => {
    const workspace = workspaceMap.get(workspaceName);
    if (!workspace) return match;
    const cwd = workspace.cwd.endsWith("/") ? workspace.cwd : workspace.cwd + "/";
    const normalizedPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
    return cwd + normalizedPath;
  });
}
