import { chatExecutionDefaultsSchema, type ChatExecutionDefaults } from "@paperclipai/shared";
import { type Db, projects } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { projectReadSqlCondition, type AuthorizationActor } from "./authorization.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { notFound } from "../errors.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Configuration selects resources; it never grants their access to future senders. */
export async function assertChatExecutionDefaultsAccess(
  db: Db,
  input: { companyId: string; actor: AuthorizationActor; assigneeAgentId?: string | null; defaults: ChatExecutionDefaults | null | undefined },
  reader: Db | DbTransaction = db,
): Promise<void> {
  const defaults = chatExecutionDefaultsSchema.parse(input.defaults ?? {});
  if (defaults.projectId) {
    const [project] = await reader.select({ id: projects.id }).from(projects).where(and(
      eq(projects.id, defaults.projectId), eq(projects.companyId, input.companyId),
      await projectReadSqlCondition(reader, input.actor),
    ));
    if (!project) throw notFound("Default project is unavailable or inaccessible");
  }
  if (defaults.workspace) await executionWorkspaceService(db).validateSelection({
    companyId: input.companyId, actor: input.actor, selection: defaults.workspace, assigneeAgentId: input.assigneeAgentId,
  }, reader);
}

/** Resolve once when a conversation creates its task. Later endpoint edits are irrelevant. */
export function resolveChatExecutionDefaults(
  endpoint: ChatExecutionDefaults | null | undefined,
  resource: ChatExecutionDefaults | null | undefined,
): ChatExecutionDefaults {
  const base = chatExecutionDefaultsSchema.parse(endpoint ?? {});
  const override = chatExecutionDefaultsSchema.parse(resource ?? {});
  return {
    ...(base.projectId !== undefined ? { projectId: base.projectId } : {}),
    ...(base.workspace !== undefined ? { workspace: base.workspace } : {}),
    ...(override.projectId !== undefined ? { projectId: override.projectId } : {}),
    ...(override.workspace !== undefined ? { workspace: override.workspace } : {}),
  };
}
