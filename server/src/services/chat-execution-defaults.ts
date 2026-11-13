import { chatExecutionDefaultsSchema, type ChatExecutionDefaults } from "@paperclipai/shared";
import { type Db, projects } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { projectReadSqlCondition, type AuthorizationActor } from "./authorization.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { forbidden, notFound } from "../errors.js";
import { accessService } from "./access.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DefaultsAccessInput = {
  companyId: string;
  actor: AuthorizationActor;
  assigneeAgentId?: string | null;
  defaults: ChatExecutionDefaults | null | undefined;
};

export async function assertChatExecutionDefaultsAccess(
  db: Db,
  input: DefaultsAccessInput,
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

export async function assertChatTaskCreationAccess(
  db: Db,
  input: DefaultsAccessInput & { assigneeAgentId: string; parentIssueId?: string | null },
  transaction: Db | DbTransaction,
): Promise<void> {
  await assertChatExecutionDefaultsAccess(db, input, transaction);
  if (!input.defaults?.projectId) return;
  const scope = {
    projectId: input.defaults.projectId,
    parentIssueId: input.parentIssueId ?? null,
    assigneeAgentId: input.assigneeAgentId,
    assigneeUserId: null,
  };
  const decision = await accessService(transaction as Db).decide({
    actor: input.actor,
    action: "tasks:assign",
    resource: { type: "issue", companyId: input.companyId, ...scope },
    scope,
  });
  if (!decision.allowed) throw forbidden(decision.explanation);
}

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
