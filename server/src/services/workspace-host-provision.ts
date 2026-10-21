import { projectWorkspaces, type Db } from "@paperclipai/db";
import type { TaskWorkspaceIntent } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";

import { resolveProjectDefaultWorkspaceId } from "./project-default-workspace.js";

export const CONTROLLER_PROVISION_COPY_ONLY = "_controllerProvisionCopyOnly";

export async function workspaceRequiresCopyOnlyProvisioning(db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0], input: {
  companyId: string;
  task: { id: string; projectId: string | null; workspaceSelection?: TaskWorkspaceIntent | null } | null;
  sourceProjectId: string | null;
  sourceWorkspaceId: string | null;
  boundWorkspace?: { sourceIssueId?: string | null; metadata?: Record<string, unknown> | null } | null;
}) {
  if (input.boundWorkspace?.metadata?.[CONTROLLER_PROVISION_COPY_ONLY] === true) return true;
  const task = input.task;
  if (!task) return Boolean(input.sourceProjectId || input.sourceWorkspaceId);
  const intent = task.workspaceSelection;
  if (intent && !["project", "operator_cwd", "task_default"].includes(intent.source)) return true;
  if (intent?.selection.kind === "existing") return true;
  if (input.boundWorkspace?.sourceIssueId && input.boundWorkspace.sourceIssueId !== task.id) return true;
  if (intent?.source === "operator_cwd" && !input.sourceProjectId && !input.sourceWorkspaceId) return false;
  if (!input.sourceProjectId || input.sourceProjectId !== task.projectId || !input.sourceWorkspaceId) return true;
  const defaultSourceId = await resolveProjectDefaultWorkspaceId(db, {
    companyId: input.companyId, projectId: input.sourceProjectId,
  });
  if (defaultSourceId !== input.sourceWorkspaceId) return true;
  const [source] = await db.select({ id: projectWorkspaces.id }).from(projectWorkspaces)
    .where(and(eq(projectWorkspaces.companyId, input.companyId), eq(projectWorkspaces.projectId, input.sourceProjectId), eq(projectWorkspaces.id, defaultSourceId))).limit(1);
  return !source;
}
