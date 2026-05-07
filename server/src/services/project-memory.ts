import os from "node:os";
import path from "node:path";
import { notFound, unprocessable } from "../errors.js";
import { slugifyClaudeCodeProjectCwd } from "../lib/claude-code-project-slug.js";
import {
  listSandboxedFilesRecursive,
  readSandboxedFile,
  type SandboxedFile,
  type SandboxedFileDetail,
} from "../lib/sandboxed-fs.js";

type ProjectLike = {
  id: string;
  companyId: string;
  codebase?: { effectiveLocalFolder?: string | null } | null;
};

export type ProjectMemoryManifest = {
  projectId: string;
  companyId: string;
  /** The cwd we slugified to derive `root`. Useful for debugging / UI tooltips. */
  resolvedCwd: string | null;
  /** The slug Claude Code uses for `~/.claude/projects/<slug>/`. */
  slug: string | null;
  /** The absolute memory directory, or null if no cwd was available. */
  root: string | null;
  /** True if `root` exists on disk. */
  exists: boolean;
  files: SandboxedFile[];
};

function resolveClaudeProjectsRoot(): string {
  return path.resolve(os.homedir(), ".claude", "projects");
}

function resolveProjectMemoryRoot(project: ProjectLike): {
  cwd: string | null;
  slug: string | null;
  root: string | null;
} {
  const cwd = project.codebase?.effectiveLocalFolder?.trim() || null;
  if (!cwd) return { cwd: null, slug: null, root: null };
  const slug = slugifyClaudeCodeProjectCwd(cwd);
  if (!slug) return { cwd, slug: null, root: null };
  const root = path.resolve(resolveClaudeProjectsRoot(), slug, "memory");
  return { cwd, slug, root };
}

export function projectMemoryService() {
  async function getManifest(project: ProjectLike): Promise<ProjectMemoryManifest> {
    const { cwd, slug, root } = resolveProjectMemoryRoot(project);
    if (!root) {
      return {
        projectId: project.id,
        companyId: project.companyId,
        resolvedCwd: cwd,
        slug,
        root: null,
        exists: false,
        files: [],
      };
    }
    const files = await listSandboxedFilesRecursive(root);
    return {
      projectId: project.id,
      companyId: project.companyId,
      resolvedCwd: cwd,
      slug,
      root,
      exists: files !== null,
      files: files ?? [],
    };
  }

  async function readFile(project: ProjectLike, requestedPath: string): Promise<SandboxedFileDetail> {
    const trimmed = typeof requestedPath === "string" ? requestedPath.trim() : "";
    if (!trimmed) {
      throw unprocessable("Query parameter 'path' is required");
    }
    const { root } = resolveProjectMemoryRoot(project);
    if (!root) {
      throw unprocessable("Project has no resolvable local folder; cannot read memory files");
    }
    const detail = await readSandboxedFile(root, trimmed);
    if (!detail) throw notFound("Memory file not found");
    return detail;
  }

  return {
    getManifest,
    readFile,
    /** Inspection helper for tests / future debug endpoints. */
    resolveRoot: (project: ProjectLike) => resolveProjectMemoryRoot(project),
    /** Stable client constant: the `~/.claude/projects/` parent root. */
    claudeProjectsRoot: resolveClaudeProjectsRoot(),
  };
}

export type ProjectMemoryService = ReturnType<typeof projectMemoryService>;
