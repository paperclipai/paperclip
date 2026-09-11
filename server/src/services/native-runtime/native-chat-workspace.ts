import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { chatConversations, issues, type Db } from "@paperclipai/db";
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
      hasConversation: sql<boolean>`exists (
      select 1 from ${chatConversations}
      where ${chatConversations.issueId} = ${issues.id}
        and ${chatConversations.companyId} = ${input.companyId}
    )`,
    })
    .from(issues)
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
    projectId: issue.projectId,
    instanceRoot,
    // This must be a sibling of agent homes, not a child readable by an old
    // provider thread whose immutable permission root is the entire agent home.
    taskRoot: path.join(
      instanceRoot,
      "chat-workspaces",
      segment(input.companyId),
      segment(input.agentId),
      segment(issue.id),
    ),
  };
}

export type NativeChatProjectWorkspace = {
  companyId: string;
  projectId: string;
  sourceIssueId: string | null;
  mode: string;
  strategyType: string;
  status: string;
  cwd: string | null;
  providerRef: string | null;
};

/** No implicit move from an intentionally configured repository to an empty cwd. */
export function nativeChatWorkspaceCwd(
  scope: NativeChatWorkspaceScope,
  workspace: NativeChatProjectWorkspace | null,
  reuseExisting: boolean,
): string | null {
  if (!scope.projectId) return workspace === null ? scope.taskRoot : null;
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
  for (const part of [
    "chat-workspaces",
    segment(scope.companyId),
    segment(scope.agentId),
    segment(scope.issueId),
  ]) {
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
