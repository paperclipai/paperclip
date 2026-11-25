import type { ResolvedWorkspaceResource, WorkspaceFileSelector } from "@paperclipai/shared";
import type { ParsedWorkspaceFileRef } from "./workspace-file-parser";

/** Server cap on `POST /file-resources/availability` (`queries` max length). */
export const WORKSPACE_FILE_AVAILABILITY_MAX_BATCH = 100;

/** Matches the file viewer's existing resolve/content cache window. */
export const WORKSPACE_FILE_AVAILABILITY_STALE_MS = 30_000;

/** The subset of a parsed ref that identifies an availability lookup. */
export interface WorkspaceFileAvailabilityRef {
  path: string;
  workspace: WorkspaceFileSelector;
  projectId: string | null;
  workspaceId: string | null;
}

/**
 * The workspace the server confirmed can serve a reference. Chips bind this to
 * their viewer URL so the click reuses the target that passed preflight instead
 * of repeating an unconstrained auto-discovery pass.
 */
export interface WorkspaceFileAvailabilityTarget {
  workspace: WorkspaceFileSelector;
  projectId: string | null;
  workspaceId: string | null;
  projectName: string | null;
}

export type WorkspaceFileAvailability =
  /** Not yet requested, in flight, or the batch failed — render as plain code. */
  | { state: "pending" }
  | { state: "unavailable"; reason: string | null }
  | { state: "openable"; target: WorkspaceFileAvailabilityTarget };

export const WORKSPACE_FILE_AVAILABILITY_PENDING: WorkspaceFileAvailability = { state: "pending" };

export function workspaceFileAvailabilityRef(ref: ParsedWorkspaceFileRef): WorkspaceFileAvailabilityRef {
  return {
    path: ref.path,
    workspace: ref.workspace ?? "auto",
    projectId: ref.projectId ?? null,
    workspaceId: ref.workspaceId ?? null,
  };
}

/**
 * Stable identity for a reference. Mirrors the server's dedup key
 * (`[workspace, projectId, workspaceId, path]`) so responses can be matched back
 * to the requests that produced them without relying on array order.
 */
export function workspaceFileAvailabilityKey(ref: WorkspaceFileAvailabilityRef): string {
  return JSON.stringify([ref.workspace, ref.projectId, ref.workspaceId, ref.path]);
}

/** Split a deduplicated ref list into request-sized chunks. */
export function chunkWorkspaceFileAvailabilityRefs<T>(
  refs: T[],
  size: number = WORKSPACE_FILE_AVAILABILITY_MAX_BATCH,
): T[][] {
  if (refs.length <= size) return refs.length > 0 ? [refs] : [];
  const chunks: T[][] = [];
  for (let index = 0; index < refs.length; index += size) {
    chunks.push(refs.slice(index, index + size));
  }
  return chunks;
}

/**
 * Derive the viewer target from a resolved resource. Project workspaces carry
 * explicit ids; execution workspaces are addressed by selector because they are
 * scoped to the issue already.
 */
export function workspaceFileAvailabilityTarget(
  resource: ResolvedWorkspaceResource,
): WorkspaceFileAvailabilityTarget {
  if (resource.workspaceKind === "project_workspace" && resource.projectId && resource.workspaceId) {
    return {
      workspace: "project",
      projectId: resource.projectId,
      workspaceId: resource.workspaceId,
      projectName: resource.projectName ?? null,
    };
  }
  return {
    workspace: resource.workspaceKind === "project_workspace" ? "project" : "execution",
    projectId: null,
    workspaceId: null,
    projectName: resource.projectName ?? null,
  };
}

/**
 * Fail closed: only a server result that is explicitly openable and carries a
 * resolved resource becomes a chip. Denied, missing, ambiguous, remote,
 * unsupported, and unmatched refs stay ordinary inline code.
 */
export function workspaceFileAvailabilityFromResult(result: {
  openable: boolean;
  unavailableReason?: string | null;
  resource: ResolvedWorkspaceResource | null;
}): WorkspaceFileAvailability {
  if (!result.openable || !result.resource) {
    return { state: "unavailable", reason: result.unavailableReason ?? null };
  }
  return { state: "openable", target: workspaceFileAvailabilityTarget(result.resource) };
}
