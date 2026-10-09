import { prepareWorkspaceRepositorySchema, selectTaskWorkspaceSchema } from "@paperclipai/shared";
import { badRequest } from "../errors.js";

function repositoryView(repo: Record<string, unknown>) {
  return { id: repo.id, repoUrl: repo.repoUrl, relativePath: repo.relativePath, requestedRef: repo.requestedRef,
    state: repo.state, pinnedCommit: repo.pinnedCommit, branchName: repo.branchName };
}

/** Transport only: authorization, receipts, and workspace decisions remain in ordinary APIs. */
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
    // PRP reserves operationId for the semantic operation name.
    return { ...rest, ...(result.repository ? { repository: repositoryView(result.repository) } : {}), preparationId: operationId };
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
