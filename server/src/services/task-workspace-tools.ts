import { prepareWorkspaceRepositorySchema, selectTaskWorkspaceSchema } from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { executionWorkspaceRepositories, type Db } from "@paperclipai/db";
import { and, asc, eq, inArray } from "drizzle-orm";

export async function pendingTaskRepository(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; workspaceId: string | null; repositoryIds?: string[];
}) {
  if (input.repositoryIds?.length === 0) return null;
  if (!input.workspaceId) return null;
  const [repository] = await db.select({ id: executionWorkspaceRepositories.id }).from(executionWorkspaceRepositories)
    .where(and(eq(executionWorkspaceRepositories.companyId, input.companyId),
      eq(executionWorkspaceRepositories.executionWorkspaceId, input.workspaceId),
      eq(executionWorkspaceRepositories.requestedByIssueId, input.issueId),
      eq(executionWorkspaceRepositories.state, "pending"),
      ...(input.repositoryIds ? [inArray(executionWorkspaceRepositories.id, input.repositoryIds)] : [])))
    .orderBy(asc(executionWorkspaceRepositories.createdAt), asc(executionWorkspaceRepositories.id)).limit(1);
  return repository ?? null;
}

export async function pendingTaskRepositoryContinuation(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; runId: string; workspaceId: string | null;
}) {
  const repository = await pendingTaskRepository(db, input);
  return repository ? { kind: "same_agent" as const, summary: "Continue with the prepared task repository.",
    idempotencyKey: `task-repository:${input.issueId}:${repository.id}:${input.runId}` } : null;
}

function repositoryView(repo: Record<string, unknown>) {
  return { id: repo.id, repoUrl: repo.repoUrl, relativePath: repo.relativePath, requestedRef: repo.requestedRef,
    state: repo.state, pinnedCommit: repo.pinnedCommit, branchName: repo.branchName };
}

export async function callTaskWorkspaceTool(input: { name: string; arguments: Record<string, unknown>; apiUrl: string; token: string; companyId: string; issueId: string; workspaceRoot?: string }) {
  let route = `/issues/${input.issueId}/workspace`;
  let method = "GET";
  let body: unknown;
  switch (input.name) {
    case "get_workspace": break;
    case "list_workspaces": route = `/companies/${input.companyId}/execution-workspaces?summary=true&selectableForTask=true`; break;
    case "select_workspace": method = "PUT"; body = selectTaskWorkspaceSchema.parse(input.arguments); break;
    case "prepare_repository": method = "POST"; route += "/repositories"; body = prepareWorkspaceRepositorySchema.parse(input.arguments); break;
    default: throw badRequest("Unknown workspace tool");
  }
  const response = await fetch(`${input.apiUrl.replace(/\/+$/, "").replace(/\/api$/, "")}/api${route}`, { method, headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Workspace tool failed (${response.status})`);
  if (input.name === "prepare_repository") {
    const { operationId, ...rest } = result;
    return { ...rest, ...(result.repository ? { repository: repositoryView(result.repository) } : {}), preparationId: operationId,
      ...(result.kind === "requires_next_admission" ? { instruction: "The repository is staged for the next admission. If unfinished work needs this checkout, finish independent work, then call paperclip_finish with reportedWorkDisposition=\"yielded\" and omit continuation (or use null). Paperclip will select the saved workspace continuation. Repository admission is routine setup; do not call paperclip_block or ask the user to restart. No timer is needed." } : {}),
    };
  }
  if (input.name === "get_workspace") {
    const workspace = result.workspace;
    return { issueId: result.issueId, bindingRevision: result.bindingRevision, selection: result.selection,
      pendingSelection: result.pendingSelection, cwd: input.workspaceRoot ?? null,
      workspace: workspace ? { id: workspace.id, projectId: workspace.projectId, mode: workspace.mode, status: workspace.status } : null,
      repositories: (result.repositories ?? []).map(repositoryView),
      capabilities: result.capabilities, fileLocations: result.fileLocations };
  }
  return result;
}
