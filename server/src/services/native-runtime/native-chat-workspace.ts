import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { chatConversations, issues, executionWorkspaces, projectWorkspaces, type Db } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";

export type NativeChatWorkspaceScope = {
  companyId: string;
  agentId: string;
  issueId: string;
  projectId: string | null;
  instanceRoot: string;
  taskRoot: string;
};

function segment(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error("native_chat_workspace_identity_invalid");
  }
  return value;
}

/** Selection is durable task state, never a caller-supplied wake/source flag. */
export async function findNativeChatWorkspaceScope(
  db: Db,
  input: {
    adapterType: string;
    environmentDriver: string | null;
    companyId: string;
    agentId: string;
    issueId: string | null;
    instanceRoot?: string;
    /** Immutable admitted input only; never a wake or prompt path. */
    admittedCwd?: string | null;
  },
): Promise<NativeChatWorkspaceScope | null> {
  if (
    input.adapterType !== "paperclip_runner" ||
    input.environmentDriver !== "local" ||
    !input.issueId
  )
    return null;
  const [issue] = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      originKind: issues.originKind,
      selection: issues.workspaceSelection,
      configuredProjectId: projectWorkspaces.projectId,
      hasConfiguredDefault: sql<boolean>`exists (
        select 1 from ${projectWorkspaces}
        where ${projectWorkspaces.projectId} = ${issues.projectId}
          and ${projectWorkspaces.companyId} = ${input.companyId}
          and (nullif(btrim(${projectWorkspaces.cwd}), '') is not null
            or nullif(btrim(${projectWorkspaces.repoUrl}), '') is not null)
      )`,
      boundWorkspaceId: executionWorkspaces.id,
      boundProjectId: executionWorkspaces.projectId,
      boundSourceIssueId: executionWorkspaces.sourceIssueId,
      boundCwd: executionWorkspaces.cwd,
      hasConversation: sql<boolean>`exists (
      select 1 from ${chatConversations}
      where ${chatConversations.issueId} = ${issues.id}
        and ${chatConversations.companyId} = ${input.companyId}
    )`,
    })
    .from(issues)
    .leftJoin(projectWorkspaces, and(eq(projectWorkspaces.id, issues.projectWorkspaceId), eq(projectWorkspaces.companyId, input.companyId)))
    .leftJoin(executionWorkspaces, and(eq(executionWorkspaces.id, issues.executionWorkspaceId), eq(executionWorkspaces.companyId, input.companyId)))
    .where(
      and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)),
    )
    .limit(1);
  if (!issue) throw new Error("native_chat_workspace_issue_unavailable");
  if (issue.originKind !== "chat_channel" && !issue.hasConversation)
    return null;
  const instanceRoot = await realpath(
    input.instanceRoot ?? resolvePaperclipInstanceRoot(),
  );
  return {
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: issue.id,
    projectId: issue.boundWorkspaceId ? issue.boundProjectId : issue.selection?.selection.kind === "task_directory" ? null : issue.configuredProjectId ?? (issue.hasConfiguredDefault ? issue.projectId : null),
    instanceRoot,
    // This must be a sibling of agent homes, not a child readable by an old
    // provider thread whose immutable permission root is the entire agent home.
    taskRoot: issue.boundSourceIssueId === issue.id && issue.boundCwd
      ? issue.boundCwd : input.admittedCwd ?? path.join(instanceRoot, "isolated-workspaces", segment(input.companyId), segment(issue.id)),
  };
}

export type NativeChatProjectWorkspace = {
  companyId: string;
  projectId: string | null;
  sourceIssueId: string | null;
  mode: string;
  strategyType: string;
  status: string;
  cwd: string | null;
  providerRef: string | null;
};

function isNativeChatTaskRoot(scope: NativeChatWorkspaceScope): boolean {
  const relative = path.relative(scope.instanceRoot, scope.taskRoot);
  const allowedTask = path.join("isolated-workspaces", segment(scope.companyId), segment(scope.issueId));
  const legacyParts = relative.split(path.sep);
  return relative === allowedTask || (
    legacyParts.length === 4 && legacyParts[0] === "chat-workspaces" &&
    legacyParts[1] === scope.companyId && /^[a-zA-Z0-9_-]+$/.test(legacyParts[2]!) && legacyParts[3] === scope.issueId
  );
}

/** No implicit move from an intentionally configured repository to an empty cwd. */
export function nativeChatWorkspaceCwd(
  scope: NativeChatWorkspaceScope,
  workspace: NativeChatProjectWorkspace | null,
  reuseExisting: boolean,
): string | null {
  if (!scope.projectId) return isNativeChatTaskRoot(scope) && (workspace === null || (
    workspace.companyId === scope.companyId && workspace.sourceIssueId === scope.issueId &&
    workspace.projectId === null && workspace.cwd === scope.taskRoot && ["active", "idle"].includes(workspace.status)
  )) ? scope.taskRoot : null;
  if (
    !reuseExisting ||
    !workspace ||
    workspace.companyId !== scope.companyId ||
    workspace.projectId !== scope.projectId ||
    workspace.sourceIssueId !== scope.issueId ||
    workspace.mode !== "isolated_workspace" ||
    workspace.strategyType !== "git_worktree" ||
    !["active", "idle"].includes(workspace.status) ||
    !workspace.cwd ||
    !path.isAbsolute(workspace.cwd) ||
    workspace.providerRef !== workspace.cwd
  )
    return null;
  return path.resolve(workspace.cwd);
}

/** Only create empty, server-owned task directories. Never import legacy bytes. */
export async function materializeNativeChatTaskRoot(
  scope: NativeChatWorkspaceScope,
): Promise<string> {
  if (scope.projectId)
    throw new Error("native_chat_workspace_project_requires_isolation");
  let cursor = scope.instanceRoot;
  const relative = path.relative(scope.instanceRoot, scope.taskRoot);
  if (!isNativeChatTaskRoot(scope)) throw new Error("native_chat_workspace_path_not_isolated");
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    await mkdir(cursor, { mode: 0o700 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    const stat = await lstat(cursor);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(cursor)) !== cursor
    ) {
      throw new Error("native_chat_workspace_path_not_isolated");
    }
  }
  return cursor;
}

export function nativeChatWorkspaceMatches(input: {
  scope: NativeChatWorkspaceScope;
  expectedCwd: string | null;
  execution: {
    binding: { companyId: string; agentId: string; issueId: string };
    workspace: { cwd: string };
  };
}): boolean {
  return (
    input.expectedCwd !== null &&
    input.execution.binding.companyId === input.scope.companyId &&
    input.execution.binding.agentId === input.scope.agentId &&
    input.execution.binding.issueId === input.scope.issueId &&
    path.resolve(input.execution.workspace.cwd) === input.expectedCwd
  );
}
