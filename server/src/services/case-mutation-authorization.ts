import { and, eq } from "drizzle-orm";
import { cases, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { assertAgentRunWriteAllowed } from "../agent-run-cancellation.js";
import { forbidden, notFound } from "../errors.js";
import type { AuthorizationActor } from "./authorization.js";
import { assertActorCanReadCase, assertActorCanWriteCase, retainCaseAccessSource } from "./case-access.js";

/** Must run in the case write transaction. The task -> run -> case order matches
 * Stop and handoff acceptance, so neither can commit between the fence and write. */
async function authorizeCaseRunMutation(tx: Db, actor: AuthorizationActor, companyId: string) {
  let sourceIssueId: string | null = null;
  if (actor.type === "agent" && actor.runId) {
    const [source] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, actor.runId), eq(heartbeatRuns.companyId, companyId),
      actor.agentId ? eq(heartbeatRuns.agentId, actor.agentId) : undefined,
    )).limit(1);
    if (!source || !actor.agentId) throw forbidden("Run binding unavailable");
    const snapshot = source.contextSnapshot;
    const issueId = source.nativeIssueId ?? source.issueId ?? snapshot?.issueId ?? snapshot?.taskId;
    const [task] = typeof issueId === "string" && isUuidLike(issueId) ? await tx.select().from(issues).where(and(
      eq(issues.id, issueId), eq(issues.companyId, companyId),
    )).for("update") : [];
    sourceIssueId = task?.id ?? null;
    const run = await assertAgentRunWriteAllowed(tx, companyId, { agentId: actor.agentId, runId: actor.runId });
    if (!run) throw forbidden("Run binding unavailable");
    if (source.runtimeMode === "native" && (!task || task.executionRunId !== actor.runId
      || task.assigneeAgentId !== actor.agentId || run.status !== "running" || task.workMode !== "standard")) {
      throw forbidden("The task is no longer writable by this run");
    }
  }
  return sourceIssueId;
}

/** New records still need the run fence before acquiring a keyed upsert lock. */
export async function authorizeCaseCreation(tx: Db, actor: AuthorizationActor, input: {
  companyId: string;
  projectId?: string | null;
}) {
  const sourceIssueId = await authorizeCaseRunMutation(tx, actor, input.companyId);
  await assertActorCanWriteCase(tx, actor, input);
  return sourceIssueId;
}

export async function authorizeCaseMutation(tx: Db, actor: AuthorizationActor, caseId: string, companyId: string) {
  const sourceIssueId = await authorizeCaseRunMutation(tx, actor, companyId);
  const [record] = await tx.select().from(cases).where(and(eq(cases.id, caseId), eq(cases.companyId, companyId))).for("update");
  if (!record) throw notFound("Case not found");
  await assertActorCanReadCase(tx, actor, record);
  await assertActorCanWriteCase(tx, actor, record);
  if (sourceIssueId) await retainCaseAccessSource(tx, { companyId, caseId, sourceKind: "issue", sourceId: sourceIssueId });
  return record;
}
